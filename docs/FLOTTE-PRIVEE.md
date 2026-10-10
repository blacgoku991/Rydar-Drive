# Flotte Privée — spécification finale

> **Statut : livré et recetté** — lots L1 à L7 faits le 10/10/2026 (commits au § 15) ; recette de bout en bout du
> § 13.3 passée sur la pile locale complète (compte rendu, contrôles et captures : `docs/EN-COURS.md`). Les écarts entre
> cette spécification et le code livré sont listés au § 15.1 : là où ils divergent, le code fait foi.
> Rédigée le 10/10/2026 sur `claude/confident-clarke-rpfwmo` (HEAD `76847b8`, dernière migration
> `20260924007500_eligibility.sql`).
>
> Base retenue : conception 1 de l'arbitrage (drapeau `organizations.private_fleet`, modèle `fleet` conservé, une
> migration principale, site externe relié par l'API v1), enrichie des greffes et des corrections de l'arbitrage. Chaque
> référence « fichier:ligne » a été revérifiée dans le dépôt. Les migrations sont citées sans le préfixe `20260924`
> (ex. `006800:1358`), **sauf** dans les commentaires « Dernière définition », qui exigent le numéro complet
> (`packages/shared/src/migrations.test.ts` cherche le numéro de 14 chiffres dans les 25 lignes qui précèdent).
>
> Ce document est la référence du chantier : chaque lot (§ 15) met à jour sa ligne « Statut » une fois terminé.

## Sommaire

0. En bref
1. Objectifs et périmètre
2. Décisions
3. Modèle de données
4. Migrations
5. Dispatch : vie d'une réservation
6. Notifications
7. Espace web du client
8. Super admin : création, clé du site, carte du client
9. Bascule vers flotte ou centrale
10. App chauffeur (dont l'agenda)
11. API v1 du site du chauffeur
12. Légal et documentation
13. Tests
14. Risques et parades
15. Lots
16. Décisions qui reviennent au propriétaire
- Annexes : A. codes d'erreur ; B. constantes partagées ; C. références de code vérifiées

---

## 0. En bref

- Une **Flotte Privée** est une organisation **flotte** ordinaire (`dispatch_model = 'fleet'`) marquée
  `organizations.private_fleet = true`. Le propriétaire (rôle `owner`) est aussi l'**unique fiche chauffeur**, sur le
  **même compte** : c'est le « compte partagé » déjà géré (`svc_login_account_shared`, `004700:19`).
- Le drapeau n'est écrit que par **deux RPC du super admin** (création, bascule). Les interdictions du pack sont des
  **invariants en base** (contrainte + déclencheurs) ; le web et l'app ne font que masquer et expliquer.
- Chaque réservation de son site (API v1, clé du site) lui est **proposée à confirmer** par notification, qu'il soit
  en ligne ou non, **sans condition de distance**. Rappels jusqu'à l'échéance (prise en charge − 60 min par défaut),
  puis « dernier appel » s'il est en ligne, puis **« Non confirmée »** (notification au chauffeur, webhook au site,
  alerte web). Rattrapage possible (« La prendre ») jusqu'à 6 h après l'heure prévue.
- **Agenda** Jour / Semaine / Mois / Liste dans l'app (route `/planning` conservée) et page Agenda sur le web, avec
  une logique commune dans `@rydar/shared`.
- **Espace web épuré** : Accueil, Agenda, Réservations, Mon site, Mon profil chauffeur, Activité, Réglages (et Frais
  Rydar s'il y a des frais). Tout le reste est masqué **et** refusé.
- **Bascule** vers flotte ou centrale par une seule RPC atomique, sur place, sans perte de données ; en centrale, le
  gérant qui roule ne se doit jamais de commission (migration `007700`).
- Deux migrations : `20260924007600_private_fleet.sql` et `20260924007700_private_fleet_owner_settlements.sql`. La
  migration du copilote (`007500` sur sa branche, en collision avec `007500_eligibility`) prendra `20260924007800` ou
  plus à sa fusion.
- App : **JavaScript seul** → EAS Update sur le runtime 1.1.0, puis intégré à la 1.2.0 des stores. Aucun module,
  aucune permission, aucun plugin.
- Juridique : rien n'est inventé. CGV, DPA et CGU inchangées dans ce chantier ; conditions particulières et contrat de
  prestations à faire rédiger et **signer avant toute activation** (§ 12, § 16).

---

## 1. Objectifs et périmètre

### 1.1 Ce que vend le propriétaire (rappel)

Une centrale de réservation qui appartient à un chauffeur VTC indépendant : un site professionnel multipage créé par
l'équipe, la création et la configuration de ses comptes Google Ads et Facebook puis la stratégie d'acquisition pilotée
par l'équipe, et un **accès partenaire** à Rydar Drive avec **ses** identifiants. Les réservations de **son** site
arrivent dans **son** application, rien que pour lui. Il ne peut ni ajouter de chauffeurs ni utiliser les fonctions des
centrales. Le super admin pourra plus tard le faire passer en flotte ou en centrale.

### 1.2 Garanties que le logiciel doit tenir

| # | Garantie | Où elle est tenue (dernier rempart en base) |
|---|---|---|
| G1 | Une seule fiche chauffeur : celle du propriétaire | déclencheur `drivers_aa_private_fleet_guard` + `org_limits` (`max_drivers` 1) |
| G2 | Aucun autre accès au tableau de bord (pas d'équipe) | `org_limits` (`max_admins` 1, appliqué par `enforce_plan_limits`, `000700:5`) |
| G3 | Ni lien `/rejoindre`, ni candidatures | contrainte `organizations_private_fleet_check` + déclencheur ; `svc_join_info` → `JOIN_LINK_INVALID`, `svc_driver_apply` → `JOIN_DISABLED` |
| G4 | Ni réseau partagé | déclencheur `network_memberships_private_fleet_guard` |
| G5 | Ni centrale, ni commissions, ni règlements chauffeur | contrainte (modèle `fleet` imposé) + déclencheur |
| G6 | Toutes les réservations de son organisation lui sont proposées, en ligne ou non, quelle que soit la distance | branche Flotte Privée de `start_dispatch` + `offer_to_fleet` (aucune condition de présence ni de position) |
| G7 | Rien que pour lui | G1 + G4 ; la clé API désigne l'organisation (`lib/api/v1.ts`) |
| G8 | Ses limites ne se lèvent ni par une offre, ni par une surcharge, ni par un achat Stripe | `org_limits` impose les limites **après** l'offre et la surcharge ; Checkout verrouillé |
| G9 | Bascule sans perte | une RPC, sur place (`organization_id` immuable partout) |
| G10 | Rien ne change pour les autres organisations | chaque branche est conditionnée par `private_fleet` ; suites existantes inchangées |

### 1.3 Hors périmètre de ce chantier

- Le site du chauffeur lui-même (construit par l'équipe, hors de ce dépôt) et l'hébergement de ce site.
- La gestion des comptes publicitaires et tout suivi de conversion (pixels, attribution).
- Les mini-sites : ils restent coupés pour toute la plateforme (`booking_sites_enabled()`, `006200:50`).
- Les prix (pack, mise en place, gestion publicitaire, frais Rydar par course) : fixés par le propriétaire.
- L'acceptation en ligne de « Conditions particulières Flotte Privée » : migration ultérieure, une fois le texte
  rédigé (§ 12.2).
- Phase 2 : rattacher un compte **existant** par invitation (§ 2, D5).

---

## 2. Décisions

| # | Décision | Justification (vérifiée dans le code) |
|---|---|---|
| **D1** | Drapeau booléen `organizations.private_fleet`, `dispatch_model` reste `'fleet'`. | Une 3e valeur toucherait la contrainte `check (dispatch_model in ('fleet','centrale'))` (`002600:38`), `svc_platform_set_fees` (`006900:2539`, refuse tout autre modèle), `sync_platform_fee` (`006900:3139`, teste `= 'fleet'`), les replis « tout ce qui n'est pas fleet est centrale » (`apps/driver/src/lib/api.ts:562`, `components/network/join-copy.ts:17`) et des dizaines de tests. Une restriction portée par l'offre seule ne tient pas : `plan_id` null = aucune limite (`002800:9`), surcharge libre, webhook Stripe qui réécrit `plan_id`. |
| **D2** | Le drapeau n'est écrit que par `svc_platform_create_private_fleet` et `svc_platform_set_private_fleet` ; marqueur de transaction `rydar.private_fleet_change` ; aucune colonne en grant update. | Toute écriture passe par un chemin qui tient l'audit, le profil de dispatch et la diffusion temps réel. Le marqueur n'est qu'une intention : la sécurité repose sur l'absence de grant client et sur les RPC réservées au service role (`assert_platform_actor`). |
| **D3** | `org_limits` impose `max_drivers` 1 et `max_admins` 1 **après** l'offre et la surcharge. `api_access` n'est pas forcé. | `enforce_plan_limits` les applique déjà (insertion, réactivation). Forcer `api_access` en SQL ferait diverger la copie TypeScript (`lib/api/v1.ts:45` et `:95`) ; on refuse plutôt une offre sans API à la création et on la signale au super admin. |
| **D4** | Invariants en base : contrainte (modèle flotte, lien fermé) + gardes `organizations`, `drivers`, `network_memberships`. | Masquer une entrée de menu ne bloque pas l'URL ; les actions du tableau de bord passent par le service role (`createDriver`, `inviteMember`) ; seule la base tient pour tous les chemins. |
| **D5** | Un seul compte Auth porte l'adhésion `owner` et la fiche chauffeur. Création **atomique** par RPC. Phase 1 : une adresse qui a **déjà** un compte est refusée ; invitation par e-mail par défaut. | `drivers.user_id` est unique (`000200:166`) et `createDriver` crée toujours un nouveau compte (`dashboard/drivers/actions.ts:57`). Règle CLAUDE.md « compte existant jamais rattaché directement » : `current_driver_id()` (`000300:101`) ne vérifie ni l'adhésion ni `jwt_issued_after`, une fiche active sur un compte existant donnerait accès aux clients sans preuve par e-mail. |
| **D6** | Le site du chauffeur est un site externe relié à `POST /api/v1/rides` (clé serveur recommandée, clé navigateur possible). | Les mini-sites sont coupés sans exception par organisation (`006200`) ; les rouvrir pour un client demanderait une exception dans `booking_sites_enabled`, `resolve_booking_host`, `reject_booking_site_ride`, `/api/tls/allowed` et la mise à jour des pages légales. |
| **D7** | Dispatch : une réservation devient une **offre « à confirmer »** au chauffeur unique par `offer_to_fleet`, via une branche dans `start_dispatch` (définition unique, `000400:335`). Le moteur (`offer_to_fleet`, `run_geo_wave`, `dispatch_tick`, `accept_ride_offer`, `decline_ride_offer`, `assign_ride`) n'est **pas recopié**. Les compléments sont des déclencheurs isolés et une petite RPC (`driver_take_ride`). | `offer_to_fleet` (`006800:1358`) n'exige ni présence ni position ; recopier 500 lignes du moteur exposerait toute la plateforme à une erreur de recopie. |
| **D8** | Échéance de confirmation = prise en charge − 60 min (réglable par le chauffeur), au moins 5 min ; puis un « dernier appel » GPS (rayon 100 km) s'il est en ligne ; puis « Non confirmée ». | Avec une échéance à T − 5 min, le client du site n'aurait aucune réponse avant la dernière minute (correction de l'arbitrage). Le dernier appel réutilise `dispatch_tick` tel quel (`006800:1493`). |
| **D9** | Une réservation qu'il saisit lui-même au tableau de bord lui est **attribuée d'office**, dans la même transaction. | Sinon une notification d'offre partirait vers lui avant l'attribution (`pg_notify` livré au commit). |
| **D10** | Agenda : RPC `driver_agenda` bornée (62 jours) + logique pure `packages/shared/src/agenda.ts` (réexportée par `@rydar/shared`, sans sous-chemin d'export) commune au web et à l'app ; route `/planning` conservée. | `driver_rides_upcoming` (`007000:679`) ne renvoie que 50 courses actives ; les notifications (`driver-context.tsx` l. 796 et 813) et la note App Review (`docs/STORES.md`) mènent à `/planning`. |
| **D11** | Bascule = une RPC atomique (sous-bloc), sur place ; exemption de règlement de la fiche du gérant (`007700`) avant toute première bascule en centrale. | `organization_id` est immuable (`forbid_org_change`, `forbid_driver_org_change`) ; deux écritures séparées laisseraient des états à moitié basculés. En centrale, `organizations_centrale_split` et `sync_ride_settlement` feraient du gérant le débiteur de sa propre centrale. |
| **D12** | Exposition du drapeau : `driver_home().organization.private_fleet`, `driver_account_state().organization.private_fleet`, `lib/auth.ts`. | Clé JSON en plus : l'app 1.1.0 l'ignore. Une seule lecture déjà faite à chaque rafraîchissement. |
| **D13** | `reassign_ride` n'est **pas** bloqué en base (écart assumé par rapport à l'arbitrage). L'interface ne propose ni « Retirer » ni « Relancer ». | `reassign_ride` est appelé en interne par `set_driver_status` (`006800:3615`) et `ban_driver` (`006800:3434`, `007400:332`) : le bloquer casserait la suspension et le bannissement de la fiche. Une course retirée reste récupérable : « La prendre » passe par `assign_ride`, qui ignore le marqueur `removed_by_dispatch`. |
| **D14** | Refus d'une offre = réservation **« Refusée »** tout de suite (`NO_DRIVER_FOUND`, webhook `ride.no_driver_found`). | Sinon une réservation refusée resterait « en recherche » jusqu'à l'échéance, parfois des jours. Garde : offre `pending` au moment du refus, course encore en recherche, aucune autre offre en attente (correction de l'arbitrage sur les refus tardifs). |
| **D15** | Juridique : CGV, DPA et CGU inchangées dans ce chantier ; référence du contrat signé **obligatoire** à la création. | Version CGV du 2026-10-02 en cours d'entrée en vigueur (2026-11-05) ; ne pas superposer une nouvelle `ORG_LEGAL_VERSION`. CGV art. 3 (« sans offre, aucune limite ») doit être dérogé par les conditions particulières signées avant activation. |
| **D16** | Clés API et webhooks du client gérés par l'équipe (super admin) ; page « Mon site » en lecture seule pour le client. | Aucun enjeu de sécurité (ce sont ses clés) mais un risque de casser son site par erreur. Décision réversible (§ 16). |

---

## 3. Modèle de données

### 3.1 `organizations`

| Élément | Définition |
|---|---|
| Colonne | `private_fleet boolean not null default false` — commentaire : « Pack Flotte Privée : un seul chauffeur (le propriétaire), ni lien d'inscription, ni réseau, ni centrale. Écrit par les RPC svc_platform_* seulement. » |
| Contrainte | `organizations_private_fleet_check check (not private_fleet or (dispatch_model = 'fleet' and not join_enabled))` ; toutes les lignes existantes valent `false`. |
| Lecture client | `grant select (private_fleet) on public.organizations to authenticated` (lecture par colonne de `004300:74-77` : sans ce grant, `select('*')` et la sélection de `lib/auth.ts:54` échouent en 42501). RLS inchangée (`organizations_select`). |
| Écriture | Aucun grant update (ni `000300:477`, ni `003900:228`). Seules les deux RPC du § 4.3-I l'écrivent, après `set_config('rydar.private_fleet_change', <id>, true)`. |
| Traces | `organizations_audit` (`audit_row_change`) journalise déjà tout changement de ligne ; les RPC écrivent en plus leur action dans `audit_logs`. |

### 3.2 `drivers`

- Colonne `owner_driver boolean not null default false` : fiche du gérant (même compte que le propriétaire). Posée par
  les RPC Flotte Privée, **conservée après une bascule** : elle sert à l'exemption de règlement en centrale (`007700`) et
  à l'affichage « prix » au lieu de « votre part » dans l'app. Hors des grants update (`000300:495`).

### 3.3 `organization_settings` : deux profils

Valeurs posées par les RPC (constantes partagées `PRIVATE_FLEET_DISPATCH_PROFILE` et `STANDARD_DISPATCH_PROFILE`).

| Réglage | Flotte Privée | Standard (posé à la sortie) | Réglable par le chauffeur |
|---|---|---|---|
| `auto_dispatch` | `true` | `true` | non (ignoré en Flotte Privée, § 4.3-G) |
| `instant_threshold_minutes` | `0` (seule une course « maintenant » est immédiate) | `45` | non |
| `scheduled_dispatch_lead_minutes` | `60` | `60` | **oui** : « Confirmer au plus tard … avant la prise en charge » (30 min à 24 h) |
| `offer_timeout_seconds` | `300` | `30` | **oui** : « Délai de réponse à une réservation immédiate » (60 à 600 s) |
| `dispatch_radii_m` | `{100000}` (dernier appel) | `{4000,8000,12000,16000}` | non |
| `dispatch_retry_radii_m` | `{}` | `{4000,8000}` | non |
| `allow_category_upgrade` | `true` | `true` | non |
| `reminder_offsets_minutes` | inchangé | inchangé | **oui** |
| `default_payment_method` | inchangé | inchangé | **oui** |

Vérifié : `{100000}` respecte la contrainte (`000200:72-73`, valeurs ≤ 100 000) ; `{}` est accepté par
`organization_settings_retry_radii_check` et `private.is_strictly_increasing` (`001700:19`) ;
`private.dispatch_plan('{100000}','{}')` vaut `{100000}` (`003200:48` : `coalesce` ne remplace pas un tableau vide) ;
toutes ces colonnes ont déjà un grant update (`000300:480`, `003200:41`).

### 3.4 Index

- `rides_driver_pickup_idx on public.rides (driver_id, pickup_at) where driver_id is not null` (agenda ; seul
  `rides_driver_idx (driver_id, status)` existe, `000200:421`). Créé sans `concurrently` : `deploy/migrate.sh` applique
  chaque migration en `psql -1`.

### 3.5 Ce qui ne change pas

- Aucune nouvelle table, aucun enum modifié (`psql -1` : une valeur d'enum ajoutée serait inutilisable dans la même
  transaction), aucune colonne nouvelle sur `rides`, `ride_offers`, `notifications`.
- Nouveau type de notification (colonne texte libre, `000200:514`) : `ride_unconfirmed`.
- Nouveaux types d'événements (`ride_events`) : `dispatch.private_offer`, `dispatch.private_self`,
  `dispatch.private_incompatible`, `dispatch.private_no_driver`, `dispatch.private_declined`, `ride.taken_by_driver`.
  Aucun n'est écouté par `ride_events_explain_retry` (`006800:2289`, qui n'écoute que `dispatch.retry`,
  `dispatch.no_driver` et `dispatch.network`).
- Nouvelles actions d'audit : `organization.private_fleet_created`, `organization.private_fleet_enabled`,
  `organization.private_fleet_disabled`, `driver.private_fleet_attached`, `api_key.created` (acteur super admin),
  `api_key.revoked`.
- Aucune donnée de production : drapeau à `false` par défaut, aucune offre (plan) insérée, `supabase/seed.sql`
  inchangé (la CI compte 29 chauffeurs et 3 organisations, `.github/workflows/ci.yml:84-85`).

---

## 4. Migrations

### 4.1 Numéros

| Numéro | Fichier | Contenu |
|---|---|---|
| `20260924007600` | `supabase/migrations/20260924007600_private_fleet.sql` | Socle complet (§ 4.3) |
| `20260924007700` | `supabase/migrations/20260924007700_private_fleet_owner_settlements.sql` | Exemption de règlement du gérant en centrale (§ 4.4) |
| `20260924007800`+ | (branche `copilot`) | Renumérotation de `007500_copilot.sql` à sa fusion ; il ne redéfinit aucune fonction de ce chantier (vérifié : seulement des tables et fonctions `copilot_*`). |

### 4.2 Règles communes (CLAUDE.md et tests)

- Une fonction redéfinie part de sa **dernière** version, gardée à l'identique hors de l'ajout, et porte
  `-- Dernière définition : 20260924xxxxxx_<nom>.sql` dans les 25 lignes qui précèdent (`migrations.test.ts`).
- Nouvelle fonction : `set search_path = ''`, `revoke all … from public, anon, authenticated` puis grants explicites
  (EXECUTE est accordé à PUBLIC par défaut). Les RPC `security definer` contrôlent l'accès elles-mêmes
  (`private.assert_platform_actor`, `private.current_driver_id()`, `private.assert_org_member`).
- Fonctions de déclencheur dans `private`, **sans** `security definer` : elles ne se déclenchent que sous des fonctions
  definer ou le service role (les colonnes qui les déclenchent ne sont modifiables par aucun client) ; les aides
  `private` qu'elles appellent sont accordées à `service_role` (chemin `createDriver`).
- Tout code levé par `raise exception 'CODE…'` a un libellé dans `ERROR_MESSAGES` (`packages/shared/src/domain.ts:197`,
  contrôlé par `error-messages.test.ts`). Les codes renvoyés en JSON en reçoivent un aussi (Annexe A).
- Rien sur `auth.*`, `storage.*`, `realtime.messages` (Supabase hébergé) ; lecture de `public.users` seulement.

### 4.3 `20260924007600_private_fleet.sql`

En-tête : objet du pack, liste des sections, rappel « organisations standard : comportement identique ».

#### A. Schéma

Colonnes, contrainte, grant de lecture et index des § 3.1, 3.2 et 3.4.

#### B. Aides privées (`set search_path = ''`, exécution : `service_role`)

| Fonction | Rôle |
|---|---|
| `private.is_private_fleet(p_org uuid) returns boolean` (sql, stable) | `coalesce((select private_fleet from organizations where id = p_org), false)` |
| `private.private_fleet_driver(p_org uuid) returns public.drivers` (sql, stable) | La fiche active : `status = 'active'`, `deleted_at is null`, `user_id is not null`, `owner_driver` d'abord. Ligne vide si aucune. |
| `private.private_fleet_blockers(p_org uuid) returns text[]` (sql, stable) | Raisons qui empêchent le passage en Flotte Privée : `model` (pas `fleet`) ; `members` (autre chose qu'un seul membre `owner` actif) ; `drivers` (plus d'une fiche non supprimée, candidatures comprises) ; `owner_driver` (aucune fiche, ou fiche d'un autre compte que le propriétaire, ou fiche non active) ; `applications` (candidature `pending`) ; `network` (`share_out` ou `share_in`, demande d'adhésion en attente — `requested_at` renseigné sans `approved_at` ni `refused_reason` —, ou partage de course ouvert). Libellés : `PRIVATE_FLEET_BLOCKER_LABELS`. |
| `private.private_fleet_dispatch(p_ride uuid) returns void` (plpgsql) | Branche Flotte Privée du démarrage (§ G). |

#### C. Garde des organisations

`private.organizations_private_fleet_guard()` — déclencheur `organizations_private_fleet_guard`
`before insert or update of private_fleet, dispatch_model, join_enabled on public.organizations` :

1. `private_fleet` posé (INSERT à `true`) ou changé (UPDATE) sans `current_setting('rydar.private_fleet_change', true) = new.id::text`
   → `PRIVATE_FLEET_LOCKED` (42501).
2. Si `new.private_fleet` : `dispatch_model <> 'fleet'` → `PRIVATE_FLEET_MODEL` (55000) ; `join_enabled` →
   `PRIVATE_FLEET_RESTRICTED` (55000). Couvre `svc_platform_set_fees('centrale')` et `set_join_link(true)` (`006300:28`),
   qui renvoient alors une erreur claire avant que la contrainte ne joue.
3. Passage `false → true` (UPDATE seulement : à la création, l'adhésion et la fiche n'existent pas encore) :
   `private.private_fleet_blockers(new.id)` non vide → `PRIVATE_FLEET_NOT_ELIGIBLE` (55000) avec la liste.

#### D. Garde des fiches chauffeur

`private.drivers_private_fleet_guard()` — déclencheur `drivers_aa_private_fleet_guard`
`before insert or update of user_id on public.drivers` (préfixe `aa_` : les déclencheurs BEFORE d'une table
s'exécutent par ordre alphabétique de nom ; il passe avant `drivers_plan_limit`, `drivers_identity_bans`… et donne un
message clair). Si l'organisation est une Flotte Privée :

- verrou consultatif `pg_advisory_xact_lock(hashtextextended('rydar.private_fleet:' || org, 0))` (deux insertions
  concurrentes sont sérialisées) ;
- `new.user_id is null` : **toujours permis** (détacher ne donne aucun accès ; couvre `delete_driver_account`,
  `007100:1122`, qui pose `user_id = null`, et l'action `on delete set null` de la clé étrangère) ;
- INSERT : une autre fiche avec `deleted_at is null` existe (candidatures comprises) → `PRIVATE_FLEET_SINGLE_DRIVER` ;
- `new.user_id` n'est pas celui d'une adhésion `owner` **active** de l'organisation → `PRIVATE_FLEET_DRIVER_OWNER`.

Couvre `createDriver` (service role), `svc_driver_apply` (lien fermé de toute façon) et toute insertion directe.

#### E. Garde du réseau partagé

`private.network_memberships_private_fleet_guard()` — `before insert or update on public.network_memberships` :
en Flotte Privée, INSERT refusé ; UPDATE refusé si `share_out` ou `share_in` est vrai, ou si `requested_at`,
`approved_at` ou `terms_version` prend une nouvelle valeur non nulle → `PRIVATE_FLEET_RESTRICTED`. Couvre les seuls
écrivains : `set_network_settings` (`007100:580`), `svc_network_approve` (`007100:266`) ; une suspension
(`svc_network_suspend`, `007100:364`) reste possible. Une ligne existante non partagée ne bloque pas un passage en
Flotte Privée (correction de l'arbitrage).

#### F. Limites : redéfinition de `private.org_limits(uuid)`

```sql
-- Dernière définition : 20260924002800_plans_optional.sql. Flotte Privée seulement : 1 chauffeur et 1 accès imposés
-- APRÈS l'offre et la surcharge (ni une offre, ni limits_override, ni Stripe ne les lèvent). Autres organisations : identique.
create or replace function private.org_limits(p_org uuid) … -- corps 002800 recopié
  select (case when o.plan_id is null
               then '{"api_access": true, "booking_site": true, "custom_domain": true, "advanced_stats": true}'::jsonb
               else coalesce(p.limits, '{}'::jsonb) end
          || coalesce(o.limits_override, '{}'::jsonb))
         || case when o.private_fleet then '{"max_drivers": 1, "max_admins": 1}'::jsonb else '{}'::jsonb end
  …
```

Copies TypeScript de la règle : `lib/api/v1.ts:45/95` ne sert qu'à `api_access` (rien à changer) ;
`components/admin/admin-widgets.tsx:216` reçoit une mention d'affichage (lot L2).

#### G. Démarrage d'une course : redéfinition de `private.start_dispatch(uuid)`

```sql
-- Dernière définition : 20260924000400_dispatch.sql (définition unique). Seul ajout : Flotte Privée → branche
-- private.private_fleet_dispatch, AVANT le test auto_dispatch (la colonne reste modifiable par le client). Autres
-- organisations : corps identique au caractère près.
```

Changements dans le corps recopié : `v_private boolean` ; `select name, timezone, private_fleet into v_org_name, v_tz,
v_private` ; juste après les trois journaux initiaux : `if coalesce(v_private, false) then perform
private.private_fleet_dispatch(r.id); return; end if;`.

`private.private_fleet_dispatch(p_ride uuid)` (sans definer : appelée par `start_dispatch`, definer) :

1. Course (déjà verrouillée), réglages, `d := private.private_fleet_driver(org)`. Journal `ride.classified`
   « Réservation immédiate » ou « Réservation du JJ/MM à HH:MM » (`data.private_fleet = true`).
2. **Aucune fiche active** (supprimée, suspendue, inactive) : `NO_DRIVER_FOUND` (`no_driver_at`, `dispatch_mode 'fleet'`,
   `dispatch_started_at`, `next_dispatch_at null`) + `dispatch.private_no_driver` (error). Fin. (Le site est prévenu par
   le webhook `ride.no_driver_found`.)
3. **Saisie par lui au tableau de bord** (`r.source = 'dashboard' and r.created_by = d.user_id`, posés par
   `before_ride_insert`, `000400:209`) : `public.assign_ride(r.id, d.id)` (`auth.uid()` est le propriétaire, membre) ;
   si `ok` : la notification `ride_assigned` en file qui lui est adressée est annulée, journal `dispatch.private_self` ;
   fin. Sinon (cas improbable : frais en retard, quota) : journal avec le code, puis étape 4.
4. `status 'SEARCHING_DRIVER'`, `dispatch_mode 'fleet'`, `dispatch_started_at now()`, `dispatch_wave 0` ;
   `n := private.offer_to_fleet(r.id)`.
5. `n > 0` : offre `o` (pending, `fleet`, fiche `d`). Sa notification en file (celle sans `data.kind`) reçoit le titre
   « NOUVELLE RÉSERVATION », `data.kind = 'private_new'` et, si `o.expires_at <= now() + 15 min`
   (`PRIVATE_FLEET_RING_WINDOW_S`), le type `ride_offer` (canal `ride-offers-v2`, sonnerie, time-sensitive) ; `data.type`
   suit. Journal `dispatch.private_offer` « Proposée — réponse attendue avant HH:MM ». Tout se fait dans la même
   transaction : `pg_notify` n'est livré qu'au commit, le worker lit la ligne finale.
6. `n = 0` (catégorie ou nombre de places incompatibles avec son véhicule) : notification `ride_unconfirmed`
   « RÉSERVATION À VÉRIFIER » (`data.reason = 'to_check'`, **sans** `ride_id` dans `data`) + journal
   `dispatch.private_incompatible`. La course reste en recherche jusqu'à l'échéance, comme une offre, puis suit le chemin
   normal ; il peut la prendre (« La prendre » ne contrôle pas la catégorie) ou l'annuler.

#### H. Déclencheurs de dispatch (aucune fonction du moteur recopiée)

**H1. Rappels « à confirmer »** — `private.ride_offers_private_fleet_reminders()`, déclencheur
`ride_offers_private_fleet_reminders after insert or update of expires_at on public.ride_offers`, quand
`new.status = 'pending' and new.mode = 'fleet' and not new.is_network` (et, en UPDATE, `old.expires_at is distinct from
new.expires_at`) :

1. Rien si l'organisation n'est pas une Flotte Privée.
2. Annule les rappels en file de cette offre (`data.kind = 'private_reminder'`).
3. Heures candidates : `pickup_at − o` pour chaque `o` de `reminder_offsets_minutes`, plus `expires_at − 30 min`
   (« dernier rappel »). Gardées si `≥ now() + 20 min` et `≤ expires_at − 5 min` ; triées ; une heure à moins de 15 min
   de la précédente retenue est écartée ; 4 au plus (`PRIVATE_FLEET_REMINDER_RULES`).
4. Chacune : `private.queue_notification(org, d, ride, offre, 'ride_offer_scheduled', 'RÉSERVATION À CONFIRMER', corps,
   data, 'high', heure)` (`000400:73`, paramètre `p_scheduled_for`). Corps : « Prise en charge dans 3 h · 14/10 08:30 ·
   Orly → Paris 8e · 85 € » ; dernier rappel : « Dernier rappel : répondez avant 07:30 · 14/10 08:30 · Orly → Paris 8e ».
   `data` : `type, kind 'private_reminder', offer_id, ride_id, ride_type, pickup, dropoff, pickup_at, price_cents,
   passengers, expires_at`.

Nettoyage sans code : `claim_notifications` (`006650:1808`) annule toute notification d'offre dont l'offre n'est plus
`pending` ; `accept_ride_offer` (`006800:1687`) annule les `ride_offer` et `ride_offer_scheduled` en file de la course.
Un vol retardé qui déplace l'échéance (`apply_flight_status`, `006800:2910`) replanifie les rappels par ce même
déclencheur.

**H2. Refus = « Refusée »** — `private.ride_offers_private_fleet_declined()`, déclencheur
`ride_offers_private_fleet_declined after update of status on public.ride_offers`, quand
`new.status = 'declined' and old.status = 'pending' and not new.is_network` : en Flotte Privée,
`update rides set status 'NO_DRIVER_FOUND', no_driver_at now(), next_dispatch_at null where id = new.ride_id and
driver_id is null and status in ('SEARCHING_DRIVER','OFFERED') and not exists (offre pending de la course)` ; si une
ligne change : journal `dispatch.private_declined` (warning). Le verrou de la course est déjà tenu par
`decline_ride_offer` (`006800:1949`) ; un refus tardif d'une offre déjà expirée (`old.status = 'expired'`) ne fait rien.

**H3. « Non confirmée »** — `private.rides_private_fleet_unconfirmed()`, déclencheur
`rides_private_fleet_unconfirmed after update of status on public.rides`, quand `new.status = 'NO_DRIVER_FOUND' and
old.status is distinct from 'NO_DRIVER_FOUND'` : en Flotte Privée, avec une fiche active `d`, et si la **dernière**
offre de `d` pour cette course n'est pas `declined` : `queue_notification(…, 'ride_unconfirmed', 'RÉSERVATION NON
CONFIRMÉE', '#1042 · 14/10 08:30 · Orly → Paris 8e : confirmez-la quand même ou prévenez votre client.',
{type, reason 'not_confirmed', booking_id, number}, 'high')`. La colonne `notifications.ride_id` est renseignée (cascade,
nettoyage) mais **jamais** `data.ride_id` : l'app 1.1.0 ouvrirait sinon `/ride/[id]`, qui renvoie `RIDE_NOT_FOUND`
pour une course non attribuée (le worker n'ajoute que `notification_id` aux données, `apps/worker/src/notifications.ts`).

#### I. RPC du super admin (`security definer`, `service_role` seul)

**I1. `public.svc_platform_create_private_fleet(p_actor uuid, p_owner uuid, p_org jsonb, p_driver jsonb, p_vehicle jsonb,
p_plan_id uuid, p_percent numeric, p_fixed_cents integer, p_contract_ref text, p_org_legal_version text,
p_org_legal_effective_on date, p_app_url text) returns jsonb`**

1. `private.assert_platform_actor(p_actor)`.
2. Contrôles, réponse `{ok:false, code, field, message}` :
   - `p_contract_ref` normalisée d'au moins 3 caractères (référence des conditions particulières et du contrat signés)
     → sinon `CONSENT_REQUIRED` (`field: contractRef`) ;
   - `p_owner = p_actor` ou compte super admin → `SELF_NOT_ALLOWED` ;
   - fiche chauffeur déjà rattachée à `p_owner` → `ALREADY_REGISTERED` ;
   - `p_owner` a déjà une adhésion, ou son `public.users.created_at` date de plus d'une heure → `OWNER_NOT_NEW`
     (défense en profondeur de D5 : le web refuse déjà toute adresse existante) ;
   - offre inactive, ou dont l'`api_access` effectif est faux → `PRIVATE_FLEET_PLAN_INVALID` ;
   - slug pris → `SLUG_TAKEN` ; slug réservé (`private.is_reserved_subdomain`, `007500`) → `SUBDOMAIN_RESERVED` ;
   - saisie incomplète ou invalide (nom commercial, identifiant, ville — obligatoire comme au § 8.1 —, fiche, véhicule)
     → `INVALID` (`field` du formulaire).
3. Sous-bloc `begin … exception` (tout ou rien) :
   1. `v_org := gen_random_uuid()` ; `set_config('rydar.private_fleet_change', v_org::text, true)` ;
      `insert into organizations (id, name, slug, email, phone, city, legal_name, siret, vtc_registration, plan_id,
      created_by, private_fleet, join_enabled)` ; marqueur remis à `''`. `handle_new_organization` (`000300:219`) crée
      les réglages et un mini-site désactivé.
   2. Adhésion `owner`, `active`, `invited_by = p_actor`, `activated_at = now()`.
   3. Réglages : profil Flotte Privée.
   4. Véhicule, puis fiche chauffeur : `user_id = p_owner`, `status 'active'`, `trust_level 'trusted'`,
      `joined_via 'dashboard'`, `owner_driver true`, `created_by = p_actor` (`enforce_identity_bans` s'applique).
   5. `v_fees := public.svc_platform_set_fees(v_org, p_actor, p_percent, p_fixed_cents, 'fleet', 'initial', null, null,
      p_org_legal_version, p_org_legal_effective_on, p_app_url)` (mode `initial` admis : organisation de moins d'une
      heure, sans course). S'il répond `ok = false` : `raise exception using errcode = 'RYD01'` → retour au point de
      sauvegarde, **rien n'est écrit** (ni organisation, ni e-mail de frais en file), et `v_fees` est renvoyé tel quel.
      Corrige l'ordre de `createOrganization`, où l'e-mail de frais partait avant la création de la fiche. Toute autre
      erreur (ex. `IDENTITY_BANNED` levé par `enforce_identity_bans`) annule toute la transaction et remonte telle quelle
      (l'action web supprime alors le compte Auth qu'elle vient de créer).
4. `audit_logs` : `organization.private_fleet_created`, `actor_type 'super_admin'`, métadonnées `{owner, driver_id,
   plan_id, percent, fixed_cents, contract_ref}`.
5. Retour `{ok:true, code:'CREATED', organization_id, driver_id}`. Aucun abonnement « trialing » n'est créé
   (facturation à décider, § 16).

**I2. `public.svc_platform_attach_private_fleet_driver(p_org uuid, p_actor uuid, p_driver jsonb, p_vehicle jsonb) returns jsonb`**

Recrée la fiche après une suppression de compte chauffeur (fiche figée `DRIVER_DELETED`) et servira à la phase 2
(compte existant invité, après activation). Contrôles : acteur ; organisation Flotte Privée (`PRIVATE_FLEET_ONLY`) ;
adhésion `owner` **active** ; aucune fiche non supprimée (`PRIVATE_FLEET_HAS_DRIVER`). Crée véhicule et fiche
(`owner_driver`, `trusted`, `active`). Audit `driver.private_fleet_attached`.

**I3. `public.svc_platform_set_private_fleet(p_org uuid, p_actor uuid, p_enabled boolean, p_consent_note text,
p_dispatch_model text default null, p_percent numeric default null, p_fixed_cents integer default null, p_fee_mode text
default 'notice', p_effective_on date default null, p_org_legal_version text default null, p_org_legal_effective_on date
default null, p_app_url text default null) returns jsonb`**

1. `assert_platform_actor` ; note normalisée d'au moins 3 caractères (demande ou accord écrit du client, CGV art. 3),
   sinon `CONSENT_REQUIRED` (`field: consentNote`) ; organisation verrouillée `for no key update` ; archivée →
   `ORGANIZATION_INACTIVE`.
2. Même état demandé sans modèle ni taux : `{ok:true, code:'UNCHANGED'}`.
3. Sous-bloc `begin … exception` :
   - **Entrée** (`p_enabled = true`) : `private_fleet_blockers` non vide → `{ok:false, code:'PRIVATE_FLEET_NOT_ELIGIBLE',
     blockers}` ; sinon marqueur, `update organizations set private_fleet = true, join_enabled = false,
     join_auto_approve = false`, profil Flotte Privée, `owner_driver = true` sur la fiche du propriétaire.
   - **Sortie** (`p_enabled = false`) : marqueur, `private_fleet = false`, profil standard ; puis, si un modèle ou des
     taux sont fournis, `public.svc_platform_set_fees(p_org, p_actor, p_percent, p_fixed_cents, p_dispatch_model,
     p_fee_mode, p_effective_on, p_consent_note, …)` dans le **même** sous-bloc ; réponse `ok = false`
     (`CONSENT_REQUIRED`, `NOTICE_TOO_SHORT`, `TERMS_NOT_NOTIFIED`, `NO_EMAIL`, `SETTLEMENTS_OPEN`…) → exception
     interne `RYD01`, rien n'est écrit, réponse renvoyée telle quelle. Ordre imposé : le drapeau d'abord (la contrainte
     refuse `centrale` tant qu'il est vrai).
   - Courses ouvertes de l'organisation (`SEARCHING_DRIVER`, `OFFERED`) : `next_dispatch_at = now()` (le tick suivant
     recalcule les échéances avec le nouveau profil). Aucune offre fermée, aucune notification en double.
4. `audit_logs` : `organization.private_fleet_enabled` ou `_disabled` (severity `warning`) avec `{note, blockers,
   dispatch_model, fees_code, open_rides}` (l'audit de `svc_platform_set_fees` s'y ajoute s'il est appelé).
5. Temps réel : `private.broadcast_platform(p_org, 'model')` (déjà dans `LAYOUT_PLATFORM_ACTIONS`,
   `dashboard-shell.tsx:157`, et accepté pour tous les rôles) ; `realtime.send({id, presence, status,
   current_ride_id}, 'driver.updated', 'driver:' || id, true)` pour chaque fiche de l'organisation (l'app relit
   `driver_home`, `driver-context.tsx` l. 645).
6. Retour `{ok:true, code, fees}`, `code` valant `PRIVATE_FLEET_ENABLED` ou `PRIVATE_FLEET_DISABLED`.

#### J. RPC du chauffeur (`security definer`, `authenticated` + `service_role`)

**J1. `public.driver_take_ride(p_ride_id uuid) returns jsonb`** — « La prendre », « Confirmer quand même »

1. Fiche `private.current_driver_id()`, sinon `FORBIDDEN` (42501).
2. Organisation de la fiche en Flotte Privée, sinon `{ok:false, code:'PRIVATE_FLEET_ONLY'}`.
3. Course de **son** organisation (sinon `RIDE_NOT_FOUND`) ; déjà à lui → `UNCHANGED` ; chauffeur présent ou statut hors
   `CREATED`, `SEARCHING_DRIVER`, `OFFERED`, `NO_DRIVER_FOUND` → `RIDE_NOT_ASSIGNABLE` ; prise en charge passée depuis
   plus de `UNSTARTED_RIDE_EXPIRY_HOURS` (6 h, `domain.ts:61`) → `RIDE_TOO_LATE`.
4. Offre en attente pour lui : `public.accept_ride_offer(offre)` ; succès → renvoyé ; `DRIVER_BUSY` ou `OFFER_EXPIRED`
   → étape 5 ; autre refus → renvoyé.
5. `public.assign_ride(course, sa fiche)` (`006800:2136` : tout membre, contrôle de frais en retard et de quota, aucune
   condition de catégorie, enchaînement si une course est en cours). Succès : annule le `ride_assigned` en file qui lui
   est adressé, journal `ride.taken_by_driver`, retour `{ok:true, code:'ACCEPTED', ride_id, chained}`.

« Annuler la réservation » n'a pas de RPC dédiée : l'app appelle `public.cancel_ride` (`000400:1111`), qui contrôle
l'adhésion (`assert_org_member`) — le chauffeur d'une Flotte Privée est le propriétaire.

**J2. `public.driver_agenda(p_from timestamptz, p_to timestamptz) returns jsonb`** (stable)

1. Fiche courante, sinon `FORBIDDEN` (42501). `p_from` ou `p_to` nul, `p_to <= p_from` ou écart > 62 jours →
   `raise exception 'AGENDA_RANGE_INVALID: …' using errcode = '22023'`.
2. `v_member := d.organization_id in (select private.member_org_ids())` (même règle que la RLS `rides_select`,
   `006700:1669` : un membre lit déjà toutes les courses de son organisation) ; `v_private := is_private_fleet`.
3. `rides` : courses où `driver_id = d.id` et `pickup_at ∈ [p_from, p_to[`, tous statuts, **mais** une course close
   (`COMPLETED`, `CANCELLED`, `NO_DRIVER_FOUND`) seulement si `updated_at > now() − 24 h` (règle RLS du chauffeur) ou si
   `v_member` et que la course est de son organisation ; JSON `private.driver_ride_json(r, d, false)` (`007000:325` :
   liste blanche, sans client d'une course partenaire) ; tri `pickup_at, id` ; 500 au plus. (Correction de l'arbitrage :
   jamais l'historique complet avec clients pour un chauffeur non membre.)
4. `unassigned` : seulement si `v_private and v_member`, sinon `null`. Courses de l'organisation sans chauffeur, statut
   `CREATED`, `SEARCHING_DRIVER`, `OFFERED` ou `NO_DRIVER_FOUND`, `pickup_at > now() − 6 h`, **quelle que soit la
   plage** ; même JSON enrichi de `offer_id`, `offer_expires_at` (son offre en attente) et `state` :
   `to_confirm` (offre en attente) | `to_check` (en recherche sans offre : véhicule incompatible) | `declined` (dernière
   offre refusée) | `not_confirmed` ; tri `pickup_at` ; 100 au plus.
5. Retour `{timezone, private_fleet, from, to, rides, unassigned}`. Droits : `revoke all from public, anon` ; `grant
   execute to authenticated, service_role`.

#### K. Lectures de l'app : redéfinitions

- `public.driver_home()` — `-- Dernière définition : 20260924006900_shared_network_money.sql`. Ajouts seulement :
  `organization.private_fleet` ; `driver.owner_driver` ; clé de premier niveau `private` **seulement** pour une Flotte
  Privée : `{unassigned: n}` = courses sans chauffeur à traiter (mêmes critères que `driver_agenda.unassigned`, sans
  offre en attente pour lui ni dernier refus). Organisation standard : seules deux clés booléennes en plus.
- `public.driver_account_state()` — `-- Dernière définition : 20260924007400_legal_review.sql`. Seul ajout :
  `organization.private_fleet`.

#### L. Droits

- Aides et fonctions de déclencheur : `revoke all … from public, anon, authenticated` ; `grant execute … to service_role`.
- `svc_platform_*` : `revoke all … from public, anon, authenticated` ; `grant execute … to service_role`.
- `driver_take_ride`, `driver_agenda` : `revoke all … from public, anon` ; `grant execute … to authenticated, service_role`.
- Fonctions redéfinies (même signature) : droits conservés.

### 4.4 `20260924007700_private_fleet_owner_settlements.sql`

- `private.sync_ride_settlement()` — `-- Dernière définition : 20260924006900_shared_network_money.sql`. Seul ajout,
  juste après le contrôle `if new.status <> 'COMPLETED' or new.driver_id is null or new.price_cents is null` :
  `if exists (select 1 from public.drivers x where x.id = new.driver_id and x.owner_driver) then return null; end if;`.
- Effet : en centrale, une course terminée par la fiche du gérant n'ouvre aucun `ride_settlements` ; il ne se doit
  jamais de commission et `driver_blocker` / `centrale_blocker` ne le bloquent pas (aucune ligne, fiche `trusted`). Les
  frais Rydar restent dus (registre séparé `platform_fee_entries`). Seul créateur de règlements propres vérifié :
  `006900:590` (l'autre insertion, `006900:405`, est réseau).
- À déployer **avant toute première bascule** d'une Flotte Privée en centrale (livré avec `007600`).

### 4.5 Ce qui n'est PAS redéfini (et pourquoi)

| Fonction | Raison |
|---|---|
| `offer_to_fleet`, `run_geo_wave`, `dispatch_tick`, `dispatch_geo_step` | Chemin standard réutilisé tel quel (D7) ; le dernier appel GPS est le passage à T-lead existant. |
| `accept_ride_offer`, `decline_ride_offer`, `assign_ride`, `redispatch_ride` | Acceptation atomique existante ; refus traité par H2 ; « La prendre » (J1, dans l'app comme sur le web) appelle `accept_ride_offer`, sinon `assign_ride`, depuis `driver_take_ride`. |
| `reassign_ride` | D13 : appelé par la suspension et le bannissement. |
| `apply_flight_status` | Il rappelle `offer_to_fleet` ou réécrit `expires_at` : H1 replanifie les rappels. |
| `set_join_link`, `svc_join_info`, `svc_driver_apply`, `approve_driver_application` | Le lien ne peut pas s'ouvrir (C) : `JOIN_LINK_INVALID` / `JOIN_DISABLED` ; la garde D tient en dernier rempart. |
| `set_network_settings`, `svc_network_approve`, `driver_set_network` | Garde E ; sans `share_in`, aucune course partenaire n'arrive. |
| `svc_platform_set_fees`, `organizations_dispatch_model_guard` | Garde C ; appelés par I1 et I3. |
| `enforce_plan_limits`, `accept_member_invitations`, `cancel_ride`, `driver_rides_upcoming`, `driver_ride_json` | Inchangés et réutilisés. |

---

## 5. Dispatch : vie d'une réservation

### 5.1 Entrées

| Canal | Point d'entrée | Ce qui se passe |
|---|---|---|
| Site du chauffeur (serveur) | `POST /api/v1/rides`, clé serveur | `source 'api'` ; prix fourni ou grille ; idempotence ; webhooks de suivi (§ 11). |
| Site du chauffeur (navigateur) | `POST /api/v1/rides`, clé navigateur (`allowed_origins`) | Prix et paiement jamais lus dans la requête (`lib/api/v1.ts:100-104` ; `app/api/v1/rides/route.ts:61` et `:96`). |
| Téléphone (lui) | « Nouvelle réservation » du tableau de bord | Attribuée d'office (§ 4.3-G étape 3). |
| Mini-site | — | Reste coupé (`006200`). |

`before_ride_insert` classe la course : avec le seuil 0, seule une course « maintenant » (heure absente ou passée) est
immédiate ; toute course datée est planifiée (elle reste acceptable pendant une autre course : `DRIVER_BUSY` ne vise que
les immédiates, `006800:1850`).

### 5.2 Parcours

1. **Création** → `start_dispatch` → branche Flotte Privée : une offre `fleet` à sa fiche, sans condition de rayon,
   de présence ni de position ; échéance `greatest(pickup − lead, now() + offer_timeout)` (`006800:1388`). Statut
   **À confirmer**. Notification « NOUVELLE RÉSERVATION » (sonnerie si l'échéance est à 15 min ou moins). Webhook
   `ride.created` vers le site.
2. **Rappels** (H1) jusqu'à l'échéance.
3. **Confirmer** (notification, écran d'offre, agenda) : `accept_ride_offer` → `ACCEPTED`, rappels de course
   (`schedule_reminders`, 24 h / 3 h / 1 h / 30 min), webhook `ride.accepted`.
4. **Refuser** : `decline_ride_offer` → H2 → **Refusée** (`NO_DRIVER_FOUND`), webhook `ride.no_driver_found`, aucune
   notification au chauffeur.
5. **Sans réponse à l'échéance** : `dispatch_tick` ferme l'offre (`fleet_window_elapsed`) et lance **une** vague GPS
   (rayon 100 km, durée `offer_timeout_seconds`) : sonnerie plein écran s'il est en ligne, disponible, avec une position
   récente (`own_geo_candidates`, `006800:573`). Puis `NO_DRIVER_FOUND` avec explication (existant) → H3 : notification
   « RÉSERVATION NON CONFIRMÉE », webhook `ride.no_driver_found`, alerte du tableau de bord (`layout.tsx`, compte des
   `NO_DRIVER_FOUND` sur 6 h).
6. **Rattrapage** jusqu'à `pickup_at + 6 h` : « La prendre » (`driver_take_ride`, dans l'app comme sur le web, où
   c'est « Je la prends », § 7.3) → `ACCEPTED`, webhook `ride.accepted` ; ou « Annuler la réservation » (`cancel_ride`,
   motif) → webhook `ride.cancelled`.
7. **Après acceptation** : inchangé (rappels, « Non effectuée » 6 h après l'heure prévue par
   `expire_unstarted_rides`, `005900:23`).

### 5.3 Exemples d'échéances (profil par défaut : lead 60 min, délai 300 s, rappels `{1440,180,60,30}`)

| Réservation reçue | Échéance | Notification initiale | Rappels | Ensuite |
|---|---|---|---|---|
| « Maintenant », 10:00 | 10:05 | `ride_offer` (sonnerie) | aucun | 10:05 dernier appel GPS jusqu'à 10:10, puis Non confirmée |
| Pour 11:10, reçue à 10:00 | 10:10 | `ride_offer` (fenêtre ≤ 15 min) | aucun | idem à 10:10 |
| Pour 12:00, reçue à 10:00 | 11:00 | `ride_offer_scheduled` | 10:30 (dernier rappel) | idem à 11:00 |
| Pour J+2 08:30 | J+2 07:30 | `ride_offer_scheduled` | J+1 08:30, J+2 05:30, J+2 07:00 | idem à 07:30 |

### 5.4 Cas particuliers

| Cas | Comportement |
|---|---|
| Hors ligne ou application fermée | L'offre `fleet` n'est jamais fermée par la présence (`driver_set_online` et `watch_driver_gps` ne ferment que les offres `geo`, `000400:1284`, `003400:66`). Il confirme depuis la notification (action « ACCEPTER »). |
| Déjà en course | Planifiée : acceptable. Immédiate : `DRIVER_BUSY` à l'acceptation → l'app propose « La prendre à la suite » (`driver_take_ride` → `assign_ride`, enchaînée par `release_driver_ride`, `004500:29`). |
| Véhicule incompatible (catégorie, places) | Aucune offre ; notification « À VÉRIFIER » ; « La prendre » possible ; sinon Non confirmée à l'échéance. Le site doit proposer sa seule catégorie et ses places (§ 11). |
| Fiche inactive, suspendue ou supprimée | `NO_DRIVER_FOUND` immédiat + alerte ; le super admin recrée la fiche (I2) si besoin. |
| Organisation suspendue | Création refusée (`ORGANIZATION_INACTIVE`) ; le tick ignore l'organisation. |
| Frais Rydar en retard | Création refusée (`rides_platform_block`) ; le site doit afficher un repli (« Appelez-nous »). |
| Vol retardé | `apply_flight_status` recalcule ; H1 replanifie les rappels. |
| `auto_dispatch` mis à faux par le client (PostgREST) | Sans effet : la branche Flotte Privée passe avant ce test (correction de l'arbitrage). |
| Suspension ou bannissement de la fiche pendant une course | `reassign_ride` interne fonctionne (D13) ; la course revient en recherche et finit Non confirmée ou annulée. |

### 5.5 Compatibilité de l'app 1.1.0 (sans la mise à jour)

- Les offres Flotte Privée sont des offres `fleet` : visibles dans Planning, rubrique « Courses proposées », et dans
  `driver_offers_v2` ; ACCEPTER / Refuser fonctionnent depuis la notification.
- Une réservation immédiate sonne (type `ride_offer`) mais ne s'ouvre pas en plein écran (`isUrgentOffer` ne vise que
  `geo` ou les fenêtres ≤ 120 s, `driver-context.tsx:118`).
- `ride_unconfirmed` (sans `ride_id`, sans `offer_id`) ouvre simplement l'application.
- Messages, « Signaler » et Réseau restent visibles mais n'ont aucun effet hors de son organisation.

---

## 6. Notifications

| Type | Quand | Titre | Canal Android / iOS | Données notables |
|---|---|---|---|---|
| `ride_offer` | Réservation dont l'échéance est à ≤ 15 min ; dernier appel GPS | NOUVELLE RÉSERVATION / NOUVELLE COURSE | `ride-offers-v2`, sonnerie, time-sensitive ; TTL `min(600, 2 × restant)` | `offer_id`, `ride_id`, `kind 'private_new'` |
| `ride_offer_scheduled` | Réservation planifiée ; rappels | NOUVELLE RÉSERVATION ; RÉSERVATION À CONFIRMER | `ride-offers-scheduled`, son court ; TTL ≤ 1 h | `offer_id`, `ride_id`, `kind` (`private_new` ou `private_reminder`) |
| `ride_unconfirmed` (nouveau) | Non confirmée (H3) ; véhicule incompatible (§ 4.3-G, étape 6) | RÉSERVATION NON CONFIRMÉE ; RÉSERVATION À VÉRIFIER | `ride-updates` (ajout à `RIDE_UPDATE_TYPES`, `apps/worker/src/push/types.ts:37`), « active » | `booking_id`, `number`, `reason` ; **jamais** `ride_id` |
| `ride_assigned`, `ride_reminder`, `ride_cancelled` | Inchangés | — | — | `ride_assigned` vers lui-même annulé quand il agit lui-même (§ 4.3-G étape 3, J1 ; sur le web, « Je la prends » passe par J1, jamais par `assign_ride`, § 7.3) |

Titres et motifs : constantes partagées `PRIVATE_FLEET_TITLES` (un test compare le SQL et `@rydar/shared`, § 13).

---

## 7. Espace web du client

### 7.1 Détection

- `apps/web/lib/auth.ts` : `private_fleet` ajouté à la sélection des adhésions (l. 54) et au type `OrgSummary` (l. 11) ;
  `driverId` (fiche déjà lue par `user_id`, l. 57) ajouté à la session. `requireOrg` et `getOrgContext` le transmettent.
- Nouveau `apps/web/lib/private-fleet.ts` (server-only) : `isPrivateFleet(org)`, `privateFleetPage(ctx, 'notFound' |
  { redirect })`, `refuseInPrivateFleet(ctx)` → `{ok:false, error: ERROR_MESSAGES.PRIVATE_FLEET_RESTRICTED}`.

### 7.2 Menu

- Nouvelle fonction pure `components/shell/dashboard-nav.ts` : `dashboardNav({privateFleet, model, role, counts,
  flags})`, qui remplace le tableau écrit en dur de `dashboard-shell.tsx:228`. Menu standard **identique** (test
  d'instantané). Sous-titre de la barre latérale : « Flotte Privée ». Icônes ajoutées à `sidebar.tsx` (`ICONS`, l. 19) :
  `home` (House), `calendar` (CalendarDays), `car` (CarFront).

| Groupe | Entrée | Route | Pastille |
|---|---|---|---|
| Mon activité | Accueil | `/dashboard` (exact) | à traiter (ambre) |
| | Agenda | `/dashboard/agenda` | — |
| | Réservations | `/dashboard/rides` | alertes (rouge) |
| | Mon site | `/dashboard/site` | — |
| Mon entreprise | Mon profil chauffeur | `/dashboard/profil` | documents à échéance (ambre) |
| | Activité | `/dashboard/stats` | — |
| | Frais Rydar | page actuelle (si `org_platform_fees_enabled`) | — |
| | Réglages | `/dashboard/settings` | — |

### 7.3 Pages

**Accueil (`/dashboard`, `components/private-fleet/private-home.tsx`, à la place de `CommandCenter`)** — lectures RLS de
membre, relecture `LiveRefresh` sur `ride.updated` et `offer.updated` (texte mis à jour par la refonte des panneaux, lot
R8 : `docs/REFONTE-PANELS.md`) :

- en-tête (`PageHeader`) : « Bonjour {prénom} », état de l'application en badge (`drivers.presence`,
  `drivers.last_seen_at` : « en ligne », « hors ligne », « en course »), date et « dernière activité il y a … » sur la
  ligne du dessous ; bouton **Nouvelle réservation (téléphone)** : `NewRideSheet` avec la mention « Elle vous est
  attribuée directement » ;
- ordre de lecture, téléphone compris : **À traiter** puis **Aujourd'hui** avant les chiffres ; sur grand écran, deux
  colonnes (à gauche À traiter et Aujourd'hui ; à droite Premiers pas, Ce mois-ci, Prochaines réservations, Mon site) ;
- **À traiter** : réservations à confirmer, à vérifier, non confirmées ; l'état et « Réponse avant HH:MM » en premier,
  puis la réservation (date, trajet, client, passagers, bagages, catégorie, prix) ; actions **Je la prends** (action
  `takeBooking` → `driver_take_ride` avec le client de l'utilisateur, comme « Confirmer » / « La prendre » dans l'app :
  offre acceptée, aucune notification « COURSE ATTRIBUÉE » vers son propre téléphone, `RIDE_TOO_LATE` contrôlé en base ;
  jamais `assignRide`), **Refuser** (action `declineOffer` → `decline_ride_offer` avec le client de l'utilisateur, même
  compte que la fiche ; confirmation qui dit la conséquence), **Appeler** (`tel:`) et, pour une demande sans prix,
  **Fixer le prix** (`EditPriceButton` → `updateRidePricing`) ; toutes par `start(() => runAction(…))`. L'annulation
  n'est pas sur l'Accueil (`BookingActions cancel={false}`) : elle se fait depuis la fiche ;
- **Aujourd'hui** et **Prochaines réservations** (5 confirmées, de la plus proche à la plus lointaine) ;
- **Ce mois-ci** : 4 `StatCard` en couleur neutre : réservations du site (`source = 'api'`), réservations terminées,
  chiffre d'affaires (somme des prix terminés), panier moyen ;
- **Mon site** : état du site (« Votre site … est relié ») et dernière réservation reçue (« #1003, aujourd'hui à
  11:04 ») ; « Détails » mène à Mon site, où restent la clé (« rdk_live_… ») et sa dernière utilisation ;
- **Premiers pas** (calculé, aucun stockage, masqué une fois complet) : entreprise complète (raison sociale, SIRET,
  n° de registre VTC), tarifs actifs, carte VTC et assurance valides, application utilisée (`last_seen_at`), site relié
  (clé active + première réservation `api`).

**Agenda (`/dashboard/agenda?vue=mois|semaine|jour|liste&date=AAAA-MM-JJ`)** — page serveur, `force-dynamic` :
courses de l'organisation sur la fenêtre `fetchWindow` de `@rydar/shared` (marge d'un jour, 1 000 au plus, index
`rides_org_pickup_idx`), regroupées par jour dans le fuseau de l'organisation ; composants `components/agenda/`
(mois : grille 6×7 commençant le lundi, 3 courses par case puis « +N » ; semaine : colonnes sur grand écran, empilée sur
téléphone ; jour : frise de 6 h à 24 h, blocs proportionnels à `estimated_duration_s`, chevauchements signalés ;
liste). Couleurs = information, par jetons (`AGENDA_KIND_META` : ambre à confirmer ou en retard, rouge non confirmée,
violet confirmée, cyan en cours, `brand` terminée, `fg-muted` annulée ou refusée). Liens `prefetch={false}`. La page
fonctionne pour toute organisation ; l'entrée de menu des flottes et centrales attend la décision du propriétaire (§ 16).
Depuis le lot R8 : mot « réservation » en Flotte Privée (« course » ailleurs) ; bouton **Nouvelle réservation
(téléphone)** dans l'en-tête ; fuseau affiché seulement s'il diffère d'Europe/Paris ; semaine sur téléphone : jours
vides consécutifs sur une ligne (« lun. 5 – ven. 9 : rien de prévu ») ; liste : titre court (« 10 oct. – 8 nov. »),
trajet sur deux lignes, « prix à fixer » ; jour vide : lien « Prochaine réservation : demain 08:30 ».

**Réservations (`/dashboard/rides` et fiche)** — variante : filtres « À traiter », « À venir », « Terminées »,
« Annulées », « Toutes » ; pas de colonne chauffeur ; libellés `PRIVATE_FLEET_BOOKING_STATES` ; sous 768 px, une carte
par réservation (état et « Réponse avant … » en premier) ; plus d'étiquette « Planifiée ». Fiche (`PageHeader`,
« ← Réservations ») : actions « Je la prends », « Refuser », « Annuler la réservation » (motif obligatoire), **« Fixer
le prix »** quand la réservation n'a pas de prix, « Modifier le prix » sinon (`updateRidePricing`) ; fenêtres fermées par
« Retour » ; **jamais** « Attribuer à… », « Relancer », « Retirer » ; pas de `RideNetworkCard` ni de `RideMoneyCard` ;
chronologie limitée à la catégorie `timeline`, les `dispatch.private_*` y figurent.

**Mon site (`/dashboard/site`, nouveau, lecture seule)** — état (« Votre site … est relié » ; « Dernier contact de
votre site : il y a 40 min · dernière réservation : aujourd'hui à 11:04 »), « Réservations reçues » (30 jours) et
« Dernière réservation reçue », liste des réservations du site sur deux lignes, liens « Vos prix » (Réglages › Tarifs)
et « Demander une modification » (formulaire `/contact`) ; « Détails techniques » repliés : type et préfixe des clés,
origines, dernière utilisation, webhooks (adresse, actif, dernier succès / échec). Organisation standard : redirection
vers `/dashboard/integrations`.

**Mon profil chauffeur (`/dashboard/profil`, nouveau)** — identité, carte VTC, véhicule, documents et échéances
(`updateDriver`, `addDriverDocument`, mise à jour du véhicule) : « Modifier ma fiche », « Ajouter un document »,
« Ajouter » sur chaque pièce manquante, expirée ou refusée ; ses propres dépôts : « Confirmer » / « Retirer » (même
action `reviewDriverDocument`) ; application jamais ouverte : « Jamais ouverte » et « Connectez-vous à l'application
avec les mêmes identifiants ». Aucune action de statut, bannissement, niveau de confiance, mot de passe ou session.
Sans fiche : « Votre fiche chauffeur a été supprimée : contactez l'équipe Rydar pour la recréer. » Organisation
standard : redirection vers `/dashboard/drivers`.

**Réglages** — onglets : « Mon entreprise » (`OrganizationForm`, n° de registre VTC compris), « Tarifs »
(`PricingEditor`), « Réservations » (nouveau formulaire, action `updatePrivateBookingSettings`, schéma
`privateBookingSettingsSchema` : confirmation au plus tard, délai de réponse, rappels, paiement par défaut — colonnes
déjà ouvertes en écriture), « Abonnement ». Onglets Dispatch, Commission et encaissement, Équipe retirés ; `?tab=` hors
liste → onglet « Mon entreprise ».

**Activité (`/dashboard/stats`)** — page existante (`components/charts/stats-view.tsx`), blocs propres aux chauffeurs
d'une flotte masqués ; mot « réservation » partout ; période sans réservation : une carte qui le dit au lieu de
graphiques vides ; canaux et catégories masqués s'ils sont vides ; sans l'offre avancée, une seule carte « Statistiques
avancées » (« Non compris dans votre offre »).

### 7.4 Masqué ET bloqué

| Fonction | Page (Flotte Privée) | Actions serveur refusées (`refuseInPrivateFleet`) | Rempart en base |
|---|---|---|---|
| Chauffeurs | `/dashboard/drivers` et `[id]` → `/dashboard/profil` | `createDriver` (**avant** toute création de compte Auth, `drivers/actions.ts:57`), `setDriverStatus`, `banDriver`, `liftDriverBan`, `setDriverTrustLevel`, `resetDriverPassword`, `revokeDriverSessions` | garde D, `org_limits` |
| Inscriptions / Réseau | `/dashboard/network` → 404 | `updateJoinLink`, `approveApplication`, `rejectApplication`, `liftIdentityBan` (`network/actions.ts:44`…) | contrainte + garde C |
| Réseau partagé | `/dashboard/reseau-partage` (+ export) → 404 | toutes celles de `reseau-partage/actions.ts` | garde E |
| Équipe | onglet retiré | `inviteMember` (`settings/actions.ts:170`), `updateMember`, `resendMemberInvitation`, `cancelMemberInvitation` | `org_limits` (`max_admins` 1) |
| Encaissements | `/dashboard/settlements` → `/dashboard` | (déjà réservées aux centrales) | modèle `fleet` imposé |
| Messages | `/dashboard/messages` → `/dashboard` | `sendChatMessage`, `markChatRead`, `removeChatMessage`, `dismissChatReport` | aucun (pas d'enjeu) |
| Journal du dispatch | `/dashboard/dispatch` → `/dashboard` | — | — |
| API & site web | `/dashboard/integrations` → `/dashboard/site` | clés et webhooks (lot L2, propriétaire du fichier `integrations/actions.ts`, D16) | — |
| Mini-site | `/dashboard/booking-site` → `/dashboard/site` | (coupé pour la plateforme) | `booking_sites_enabled()` |
| Réglages Dispatch / Centrale / WhatsApp | onglets retirés | `updateDispatchSettings`, `updateCentraleSettings`, `updateReminderChannels`, `saveOrgWhatsApp`, `removeOrgWhatsApp`, `testOrgWhatsApp` | profil posé par les RPC |
| Attribuer / Relancer / Retirer une course | boutons absents | `assignRide`, `redispatchRide`, `relaunchRide` | D13 |
| Changement d'offre | panneau limité | `/api/billing/checkout` : en Flotte Privée, `allowed = plan.id === org.plan_id` (jamais une offre publique, l. 51) | `org_limits` |

Un test statique `components/shell/private-fleet-guards.test.ts` (modèle : `dashboard-links.test.ts`) vérifie que
chaque page et chaque action listées appellent la garde. Les actions de `integrations/actions.ts` (lot L2) n'en font pas
partie : elles lisent `organizations.private_fleet` elles-mêmes (`lib/private-fleet.ts` appartient au lot L3) et sont
vérifiées par `lib/private-fleet-admin.test.ts`.

### 7.5 Layout

`app/dashboard/layout.tsx` en Flotte Privée : ne lit ni `loadChatCounts`, ni `countPendingDocuments`, ni
`fetchCentraleCounts`, ni `networkAccess`, ni les réglages de centrale ; lit à la place le compte « à traiter » (une
requête légère). Gardés : alerte `NO_DRIVER_FOUND`, `OrgTermsGate` (CGV et DPA à accepter avant tout), bandeaux CGU,
`org_platform_fees_enabled`.

### 7.6 Abonnement

`settings/page.tsx:123` et `BillingPanel` en Flotte Privée : seulement l'offre attribuée (même non publique), factures
et portail ; sans offre : « Abonnement géré par l'équipe Rydar ». Le portail Stripe doit être configuré sans changement
d'offre (DEPLOYMENT, § 16).

### 7.7 Conventions

`onSubmit={submitWith(fn)}`, `Field`, `runAction`, `fieldErrors` / `describeError`, `useLiveSync` / `LiveRefresh`,
`dateTimeFormat` / `numberFormat` (jamais `new Intl` au rendu), heures saisies dans le fuseau de l'organisation
(`components/booking/zoned-time.ts`), jetons de `globals.css`, contraste ≥ 4,5:1, `<Link prefetch={false}>`, fichiers
« use server » qui n'exportent que des fonctions async, `export const dynamic = "force-dynamic"`.

---

## 8. Super admin : création, clé du site, carte du client

Fichiers : `apps/web/app/admin/flotte-privee/actions.ts` (« use server », fonctions async seulement),
`apps/web/components/admin/private-fleet.tsx`, `apps/web/lib/api-keys-server.ts` (server-only : `insertKey` extrait de
`app/dashboard/integrations/actions.ts:20`, comportement identique).

### 8.1 Création — `createPrivateFleet(input)`

Formulaire `CreatePrivateFleetSheet` (bouton « Nouveau client Flotte Privée » sur `/admin/organizations`), schéma
`privateFleetCreateSchema` + `PRIVATE_FLEET_CREATE_LABELS` :

- **Client** : nom commercial, slug (proposé ; indice basé sur `NEXT_PUBLIC_ROOT_DOMAIN`, pas `rydar.app` en dur),
  e-mail, téléphone, ville ; facultatifs : raison sociale, SIRET (14 chiffres), n° d'inscription au registre VTC.
- **Chauffeur-propriétaire** : prénom, nom, **e-mail de connexion**, téléphone, n° de carte VTC.
- **Véhicule** : marque, modèle, couleur, plaque, catégorie, places, bagages.
- **Frais Rydar par course** : `FeeFields` du modèle flotte, 0 par défaut (aucun montant proposé par le code).
- **Offre** : facultative (une offre non publique créée dans `/admin/plans`) ; refusée sans `api_access`.
- **Référence du contrat signé** : obligatoire (conditions particulières + contrat de prestations, § 12).

Étapes :

1. `requireSuperAdmin()` ; validation.
2. `findUserIdByEmail` (`lib/member-invite.ts:17`, égalité, jokers échappés) : compte existant → refus « Cette adresse a
   déjà un compte Rydar : demandez une autre adresse au client » (phase 1, D5).
3. `admin.auth.admin.inviteUserByEmail(email, { data: { full_name }, redirectTo: ${appUrl}/auth/set-password })` ;
   option « mot de passe provisoire » seulement derrière une case explicite et un avertissement (accès connu de
   l'équipe ; à changer par « Mot de passe oublié »), pour un serveur sans e-mail.
4. `rpc('svc_platform_create_private_fleet', …)` avec `feeTermsParams()` (`admin/actions.ts:39`). Erreur ou
   `ok = false` → suppression du compte Auth créé à l'étape 3 (compensation), message et `fieldErrors`.
5. Pas d'`audit()` en TypeScript : la RPC écrit l'audit. Revalidation de `/admin` et `/admin/organizations`.
6. Message : « Invitation envoyée à … : le client choisit son mot de passe, accepte les CGV dans son espace web, puis se
   connecte à l'application avec les mêmes identifiants. »

### 8.2 Clé du site — `createPrivateFleetSiteKey(orgId, {kind, origins, name})` et `revokePrivateFleetSiteKey`

- Conditions : organisation Flotte Privée et active ; CGV et DPA `ORG_LEGAL_VERSION` acceptés au nom de
  l'organisation (`legal_acceptances`, document `dpa`, lu en service role) — bouton désactivé sinon.
- **Clé serveur** (recommandée : backend du site) : `rides:create`, `rides:read`, `rides:cancel`, `rides:quote`,
  `webhooks:manage` ; le site enregistre lui-même ses webhooks par `POST /api/v1/webhooks`.
- **Clé navigateur** : `rides:create`, `rides:quote` + origines (`privateFleetSiteKeySchema` : https, 5 au plus, avec la
  variante www) ; limites par IP du § 11.
- La clé complète n'est affichée **qu'une fois**, avec l'extrait d'intégration. `audit('api_key.created',
  actorType 'super_admin', {prefix, kind, scopes, origins})` ; révocation : `revoked_at`, `revoked_by`,
  `audit('api_key.revoked')`. `api_keys_plan_limit` (`PLAN_FEATURE_API`) s'applique toujours.

### 8.3 Fiche du client (`/admin/organizations/[id]`)

- Carte **Flotte Privée** en tête : chauffeur = propriétaire, statut de la fiche, application utilisée
  (`last_seen_at`), invitation acceptée (première connexion), CGV/DPA acceptés (version, date), offre et
  `api_access`, référence du contrat (audit de création).
- Sous-carte **Site du client** : clés (type, préfixe, origines, dernière utilisation, révoquée), créer / révoquer,
  dernières réservations `api`.
- **Recréer la fiche chauffeur** si aucune (I2).
- **Passer en flotte standard** et **Passer en centrale** : dialogue du § 9.4.
- `DispatchModelForm` (`components/admin/dispatch-model.tsx`) : choix du modèle désactivé (« Sortez d'abord de la
  Flotte Privée ») ; les taux restent modifiables (règles de hausse existantes).
- `OrganizationPlanForm` (`admin-widgets.tsx:218`) : mention « 1 chauffeur et 1 accès imposés par la Flotte Privée » ;
  `updateOrganizationPlan` (`admin/actions.ts:746`) refuse une offre dont l'`api_access` effectif serait faux.
- `OrganizationAccessCard` et carte Réseau masquées ; `grantOrganizationAccess` refusé en Flotte Privée (le support lit
  par la RLS du super admin et agit par ces cartes ; il ne devient jamais membre).
- Organisation **standard** : bouton « Passer en Flotte Privée », préconditions affichées à titre indicatif (lectures en
  service role) ; la RPC fait foi (`PRIVATE_FLEET_NOT_ELIGIBLE` + liste).

### 8.4 Passerelle depuis `/admin/contacts/[id]`

Demande de sujet `eligibility` (`007500`) : bouton « Créer le client Flotte Privée » qui ouvre le formulaire prérempli
(nom découpé en prénom et nom, e-mail, téléphone, entreprise). Après la création, la demande passe « traitée » avec la
note « Client créé : <organisation> » (action existante des demandes).

### 8.5 Autres écrans

- `/admin/organizations` : colonne ou badge « Flotte Privée », filtre `?type=flotte-privee`.
- `/admin/frais` : inchangé (modèle flotte, `006400`).

---

## 9. Bascule vers flotte ou centrale

### 9.1 Vers une flotte standard (`svc_platform_set_private_fleet`, `p_enabled = false`)

- `private_fleet = false` ; profil standard (45 min, 60 min, 30 s, 4 → 8 → 12 → 16 km, relance 4 → 8 km) ; limites de
  l'offre de nouveau (sans offre : **aucune limite**, `002800:9` — le dialogue impose de choisir une offre ou de
  l'assumer).
- Deviennent possibles : ajouter des chauffeurs (`createDriver`), inviter des membres, ouvrir le lien `/rejoindre`
  (fermé, conservé depuis `006300`), le réseau partagé si Rydar l'ouvre.
- Conservés : courses, clients, prix, grilles, fiche du gérant (`trusted`, `owner_driver`), documents, clés API et
  webhooks (le site continue de réserver), registre des frais, acceptations légales, abonnement.
- Diffusion : le tableau de bord passe au menu standard sans rechargement complet ; l'app relit `driver_home`.

### 9.2 Vers une centrale (même appel, `p_dispatch_model = 'centrale'`)

- `svc_platform_set_fees` dans le même sous-bloc : note d'accord obligatoire, hausse sur accord écrit (`consent`) ou
  annoncée 30 jours avant (`notice`), baisse immédiate.
- `organizations_centrale_split` (`004400:734`) répartit les courses non closes qui ont un prix.
- Grâce à `007700`, les courses de la fiche du gérant n'ouvrent aucun règlement ; les autres chauffeurs suivent les
  règles de la centrale.

### 9.3 Retour en Flotte Privée

Même RPC, `p_enabled = true`, refusée si une raison de `private_fleet_blockers` existe (une centrale repasse d'abord en
flotte, ce qui peut échouer en `SETTLEMENTS_OPEN`). Acceptée : lien fermé, profil Flotte Privée, `owner_driver` posé.

### 9.4 Dialogue « Changer d'offre de service » (`PackConversionDialog`)

« Ce qui change » / « Ce qui reste », cible (flotte, centrale), offre, taux préremplis et mode (accord écrit ou
annonce + date), **note d'accord obligatoire**, nombre de courses en recherche (bascule conseillée hors recherche en
cours), avertissement financier pour la centrale. Action `setPrivateFleet(orgId, input)` (schéma
`privateFleetSwitchSchema`) → RPC ; pas d'`audit()` doublé.

---

## 10. App chauffeur

### 10.1 Principes

JavaScript seul : EAS Update sur le runtime 1.1.0, puis intégré à la 1.2.0. **Aucun** changement de `app.config.ts`,
de dépendance native, de permission, de plugin ou d'icône. Toute fonction refusée l'est aussi par le serveur : l'app ne
fait que simplifier. Aucune nouvelle clé AsyncStorage (donc rien à ajouter à `/cookies`) : la vue choisie de l'agenda
est gardée en mémoire le temps de la session.

### 10.2 Détection (`src/hooks/driver-context.tsx`)

`privateFleet = home?.organization.private_fleet === true || account?.organization?.private_fleet === true` ;
`ownerDriver = home?.driver.owner_driver === true` ; exposés par `useDriver()`. Clé absente (serveur plus ancien) =
standard. Relus à chaque `refresh` (dont `driver.updated`, diffusé par la bascule) et par `checkAccount` (60 s).

### 10.3 Accueil (`app/(app)/home.tsx`, barre l. 363-403)

- Flotte Privée : boutons Profil, « Aujourd'hui », **Agenda** (`calendar-outline`, même route `/planning`) avec une
  pastille = offres `fleet` en attente + `home.private.unassigned` (ambre s'il y a des non confirmées).
- Masqués : Messages, « Signaler » et la pastille des signalements (l. 444), `NetworkBanner`.
- Panneau : « Prochaine course » ; ligne « À confirmer (n) » vers l'agenda ; texte d'information (`muted`) « Vos
  réservations arrivent même application fermée. » ; **bandeau si les notifications sont refusées**
  (`Notifications.getPermissionsAsync`, JS) : « Notifications désactivées : vous ne serez pas prévenu de vos
  réservations » + accès aux réglages.
- Le passage en ligne reste (GPS pendant la course, dernier appel) ; `requestLocationPermissions()` reste la seule porte.

### 10.4 Profil et gardes

- Visibles : Mes gains, Agenda, Mes documents, Véhicule, CGU, Confidentialité, Supprimer mon compte, Se déconnecter.
- Masqués : Messages, Commissions, Courses partenaires, Réseau partagé (interrupteur, conditions, IBAN), « Appeler la
  centrale » (ce serait son propre numéro). Aucun lien vers l'espace web (il contient l'abonnement : règles Apple 3.1.x).
- Gardes : `messages`, `commissions`, `network-terms`, `payout` font `router.replace('/home')` en Flotte Privée.
- `delete-account.tsx` : « Votre fiche chauffeur sera supprimée : les réservations de votre site ne vous seront plus
  proposées tant que l'équipe Rydar ne l'a pas recréée. Votre espace web et vos réservations restent. » (le compte de
  gestion est conservé : `DRIVER_PROFILE_DELETED`).
- `ownerDriver` (après une bascule en centrale) : le prix est affiché, jamais « votre part » ni commission (offres,
  course, gains).

### 10.5 Agenda (route `/planning`, écran `app/(app)/planning.tsx`)

**En-tête** : `ScreenHeader` « Agenda » (Flotte Privée) ou « Planning » (standard) ; à droite, puce « Aujourd'hui »
(48 px). `Segmented` **Liste · Jour · Semaine · Mois** (cibles de 48 px, libellés complets pour le lecteur d'écran).
Vue par défaut : **Liste** pour un chauffeur standard (aucun changement, compte de démonstration App Review compris),
**Mois** pour la Flotte Privée. Barre de période pour Jour / Semaine / Mois : boutons ‹ › de 48 px et libellé
(« mardi 14 octobre », « 12 – 18 oct. », « octobre 2026 ») ; aucune navigation par balayage (pas de conflit avec le
geste retour d'iOS, aucun `gestureEnabled` à changer).

**Bloc « À traiter »** (au-dessus de toutes les vues) :

- Flotte Privée :
  - **À confirmer · n** — cartes issues de `driver_agenda.unassigned` (`state = 'to_confirm'`) jointes aux offres du
    contexte : heure (`mono`, « dans 3 h », « demain »), trajet (`RouteLine`), prix, passagers et bagages, nom du client,
    « Réponse avant 07:30 », avertissements (catégorie ou places au-delà de son véhicule ; chevauchement avec une course
    confirmée, calculé par `overlaps` de `@rydar/shared`). Boutons **Confirmer** (`BigButton` 56 px, `api.accept` ;
    `DRIVER_BUSY` → confirmation « La prendre à la suite ? » → `api.takeRide`), **Refuser** (56 px, confirmation →
    `api.decline`), **Appeler le client** (48 px, `tel:`).
  - **Non confirmées · n** — `state` `to_check`, `not_confirmed` (et `declined`, en `muted`) : **La prendre**
    (`api.takeRide`, confirmation, message du code renvoyé), **Annuler la réservation** (`BottomSheet`, motif de 3 à
    280 caractères → `rpc('cancel_ride')`), **Appeler le client**.
- Standard : « Courses proposées » (offres `fleet`) comme aujourd'hui.

**Vues** :

| Vue | Contenu | Interactions |
|---|---|---|
| Liste | « Mes courses » à venir groupées par jour (« Aujourd'hui », « Demain », « jeudi 16 octobre »), indications `overdue` et `waitsForCurrentRide` (`src/lib/planning.ts`) | toucher → `/ride/[id]` |
| Jour | Frise 0-24 h (64 px par heure) dans un `ScrollView` placé sur maintenant (aujourd'hui) ou 1 h avant la 1re course ; blocs placés selon la prise en charge, hauteur selon `estimated_duration_s` (30 min et 48 px au moins), chevauchements côte à côte avec la mention « Chevauchement » ; trait « maintenant » statique recalculé par `useNow(60_000)`, sans animation | bloc → `/ride/[id]` ou `/offer/[id]` ; jour vide : « Aucune course ce jour-là. » |
| Semaine | 7 lignes (lundi en premier) : jour, nombre, total (`mono`), jusqu'à 3 éléments compacts (« 08:30 Orly → Paris 8e ») puis « +n » | ligne → vue Jour de ce jour |
| Mois | Grille 7 × 6 (L M M J V S D), cellules ≥ 48 × 52 px (≈ 49 px de large à 375 px avec 16 px de marge), chiffre en `mono`, jusqu'à 3 points de 6 px puis « +n » ; aujourd'hui : contour `brand` ; jour choisi : fond `surface2` ; jours hors du mois : `muted` | toucher un jour → liste du jour sous la grille avec le total « 3 courses · 245 € » |

**États** : chargement (« Chargement… » en `muted`, sans animation en boucle) ; erreur : dernière vue gardée + bandeau
« Connexion impossible : l'agenda n'est peut-être pas à jour. » + « Réessayer » ; vide par vue ; serveur sans
`driver_agenda` (PGRST202) : repli `withLegacy` sur `driver_rides_upcoming` (à venir seulement, sans bloc « Non
confirmées »).

**Couleurs (information, `toneColor`)** : `AGENDA_KIND_META` — ambre (à confirmer, à vérifier, heure dépassée), rouge
(non confirmée), violet (confirmée planifiée), cyan (en cours), vert (terminée), `muted` (annulée, refusée).

**Données** : `api.agenda(from, to)` = `withLegacy('driver_agenda', …)` sur la fenêtre `fetchWindow(vue, jour)` de
`@rydar/shared` (≤ 44 jours, marge d'un jour), regroupement par `localIsoDay(pickup_at, fuseau)`. Ni
`zonedTimeToUtc` ni `formatToParts` dans l'app (Hermes) ; libellés de jours au format éprouvé d'`earnings.tsx`
(`AAAA-MM-JJT12:00:00Z`, fuseau UTC) mais via `dateTimeFormat` (jamais `new Intl` au rendu). Rechargement :
`useFocusEffect`, « tirer pour actualiser », `useAppEvent('ride')`, changement des offres du contexte.

**Accessibilité** : cellule « mardi 14 octobre, 3 courses dont 1 à confirmer » ; boutons nommés ; `accessibilityRole`.

**Fichiers** : `src/components/agenda/` (`month-grid.tsx`, `week-list.tsx`, `day-timeline.tsx`, `period-bar.tsx`,
`booking-card.tsx`), `src/lib/agenda-view.ts` (modèle de vue pur, couleurs, libellés `frTypo`, textes d'accessibilité). Comme
`src/lib/network.ts`, ce module et `offer-urgency.ts` n'importent que `@rydar/shared` et des chemins relatifs (`frTypo` de
`./settlement-text`), jamais `react-native` ni l'alias `@/` : vitest (environnement node) doit pouvoir les charger.

### 10.6 Écran d'offre (`app/(app)/offer/[id].tsx`)

Flotte Privée : titre « Nouvelle réservation » ; compte à rebours en minutes pour une longue fenêtre ;
`DRIVER_BUSY` → « La prendre à la suite » ; avertissement catégorie ou places. Ouverture plein écran : nouvelle fonction
pure `src/lib/offer-urgency.ts` (`isUrgentOffer(o, { privateFleet })`) = règle actuelle **ou** (Flotte Privée et fenêtre
≤ `PRIVATE_FLEET_RING_WINDOW_S`) ; jamais pendant une course (logique `onRide` existante, l. 495).

### 10.7 Notifications (`handleResponse`, l. 723)

`ride_unconfirmed` → `/planning` (bloc « À traiter », focus sur `booking_id`) ; ajouté aux types qui déclenchent
`refresh()` au premier plan ; `kind` `private_new` / `private_reminder` : mêmes chemins que les offres.

### 10.8 Design

Jetons de `theme.ts`, graisses ≤ 700, chiffres en `mono`, `frTypo`, texte d'information en `muted` (jamais `subtle`),
aucun emoji, ni dégradé, ni flou, ni pastille d'icône teintée, ni animation en boucle ; couleur = information ; cibles
≥ 48 px, 56 px pour Confirmer et Refuser ; textes GPS et de service Android **inchangés** (conformité stores : « votre
centrale » désigne ici sa propre entreprise).

### 10.9 Publication

1. Migrations `007600` et `007700`, puis web et worker (VPS).
2. EAS Update de production sur le runtime 1.1.0 (JS seul).
3. Build 1.2.0 et envoi aux stores (avec ou sans le copilote : décision du propriétaire) ; la note App Review ne change
   pas (compte de démonstration resté flotte standard).

---

## 11. API v1 du site du chauffeur

- **Clé** : serveur (recommandée) ou navigateur, créée par le super admin (§ 8.2).
- **Devis** : nouveau `POST /api/v1/quotes` (portée `rides:quote`, permise aux clés navigateur) : géocodage et
  itinéraire comme `POST /rides`, prix par `bookingSitePrice` (`lib/booking-price.ts`, même calcul que le devis et la
  réservation du mini-site) ; réponse `{price_cents, currency, fixed_fare, estimated_distance_m, estimated_duration_s,
  vehicle_category, pickup_at}` ; aucune course créée.
- **Prix attendu** : champ facultatif `expected_price_cents` sur `POST /api/v1/rides` (schéma partagé). Fourni : le prix
  est recalculé par la même fonction ; différent → **409 `PRICE_CHANGED`** avec `details.price_cents` (nouveau prix ou
  `null`), rien n'est créé. Absent : comportement actuel inchangé. C'est la condition d'un bouton « Réserver avec
  obligation de paiement » conforme sur le site.
- **Limites par IP des clés navigateur** (aujourd'hui seule la clé est limitée) : `rateLimitAll` + `ipBucket(ipFromHeaders)`,
  mêmes plafonds que le mini-site (`app/book/[slug]/actions.ts:37-40`, `:99-101`, et devis `app/api/book/[slug]/quote`) :
  création 6 / 10 min et 20 / jour par IP, 3 / h par téléphone client ; devis 30 / min et 600 / jour par IP ; 429 avec
  `Retry-After`. Clés serveur inchangées.
- `authenticate()` (`lib/api/v1.ts:101`) : la portée d'une clé navigateur est contrôlée par `BROWSER_KEY_SCOPES`.
- **Webhooks** pour informer le client du site : `ride.accepted` (confirmée), `ride.no_driver_found` (refusée ou non
  confirmée), `ride.cancelled`, `ride.search_restarted`.
- **Règles pour le site** (dans `docs/API.md`) : proposer seulement sa catégorie de véhicule et ses places ; afficher
  « en attente de confirmation par votre chauffeur » après la réservation (statut `OFFERED`) ; repli « Appelez-nous »
  sur toute erreur (frais en retard, quota) ; prix affiché avant la commande ou « demande sans prix » ; délai minimal de
  réservation conseillé ; aucun traceur sans gestionnaire de consentement.

---

## 12. Légal et documentation

### 12.1 À signaler au propriétaire (rien n'est inventé ici)

- **Contrat** : « Conditions particulières Flotte Privée » (partie logiciel : un seul chauffeur, ni recrutement, ni
  commission, ni réseau, changement d'offre par l'éditeur à sa demande, bascule sans perte, fonctionnement « à
  confirmer », dérogation expresse à CGV art. 3 « sans offre, aucune limite » et art. 4 « changer d'offre à tout
  moment ») et **contrat de prestations** distinct (site, comptes publicitaires, pilotage) : à faire rédiger et relire
  par un avocat, **signés avant toute activation** ; la référence est saisie à la création (I1).
- **Budget publicitaire** payé directement par le client à Google et Meta (CGV art. 1 : Rydar n'encaisse rien) ; comptes
  publicitaires, domaine et contenus **au nom du client** ; cession écrite des droits sur le site (CPI L131-3) ;
  réversibilité au-delà de l'export CSV (art. 8) ; propriété intellectuelle (art. 14) ; aucune garantie de résultat
  (art. 9 et 12, déjà dit dans la FAQ de `/eligibilite`).
- **Points à valider** : mandat écrit si l'équipe achète l'espace publicitaire (loi Sapin, art. 20) ; droit de
  rétractation de 14 jours (C. conso. L221-3, déjà cité par `/abonnement-resiliation` § 1) ; règles Google Ads et Meta
  pour les tiers qui gèrent des comptes ; promesse « 15 places » à garder vraie.
- **Données** : si Rydar ou un prestataire héberge le site du client, mettre à jour **d'abord** `/dpa` (sous-traitants),
  `/confidentialite`, `/mentions-legales` et `docs/RGPD-REGISTRE.md` ; site du client : ses propres mentions légales
  (entreprise, n° VTC, hébergeur), sa politique de confidentialité, gestionnaire de consentement CNIL avant tout pixel.
  `/eligibilite` et le site Rydar restent sans traceur.
- **Promesses de `/eligibilite`** (`app/eligibilite/page.tsx`) : « ton agenda des courses planifiées », « tes
  identifiants », « chaque réservation de ton site qui tombe dans ton téléphone », « tu choisis les courses que tu
  prends » deviennent vraies avec ce chantier (à livrer **avant** de vendre) ; « suivi des réservations venues de tes
  pubs » (l. 48) n'est **pas** fourni par Rydar : à retirer ou à prévoir (§ 16).
- **CGU** (`LEGAL_VERSION`) : inchangées (« pour le compte de sa centrale » désigne ici sa propre entreprise) ; à
  reformuler à la prochaine version. Profiter de la prochaine `ORG_LEGAL_VERSION` pour corriger la puce inexacte de
  `ORG_LEGAL_CHANGES` (« L'accord de traitement des données ne change pas »).
- **Stores** : aucun lien d'achat ni d'éligibilité dans l'app ; App Privacy et Sécurité des données inchangées.

### 12.2 Plus tard : acceptation en ligne des conditions particulières

Migration au numéro libre suivant, une fois le texte rédigé : document `private_fleet` dans
`legal_acceptances_document_check` (`006700:115`), version dans `platform_settings`, constante dans `@rydar/shared`,
page publique `/flotte-privee/conditions` (copies figées par version), acceptation par le propriétaire dans
`OrgTermsGate` (modèle : convention du réseau partagé, `006700`).

### 12.3 Documentation à mettre à jour (lots L4 et L6)

| Fichier | Contenu |
|---|---|
| `CLAUDE.md` | Une ligne dans « Métier » : Flotte Privée = `organizations.private_fleet` (modèle flotte), limites imposées par `org_limits`, gardes (lien, réseau, modèle, une fiche), dispatch « à confirmer », RPC `svc_platform_*_private_fleet`, `driver_agenda`, migrations 007600-007700 (texte soumis au propriétaire). |
| `docs/ARCHITECTURE.md` | § « Flotte Privée » (drapeau, gardes, dispatch, notifications, agenda, bascule) ; renvois depuis § 3 (planifiées), § 10 (modèles), § 13 (frais). |
| `docs/SECURITY.md` | Invariants, marqueur `rydar.private_fleet_change`, Checkout verrouillé, clés gérées par l'équipe, refus avant toute création de compte Auth, défense « compte neuf ». |
| `docs/API.md` | Section « Site d'un client Flotte Privée » : clés, devis, `expected_price_cents`, `PRICE_CHANGED`, limites par IP, webhooks, règles du site (lot L4). |
| `docs/DEPLOYMENT.md` | Procédure de création d'un client ; ordre migrations → web et worker → EAS Update ; portail Stripe sans changement d'offre ; e-mails Auth requis pour l'invitation. |
| `docs/STORES.md` | Aucune modification obligatoire (compte de démonstration resté flotte). |
| `docs/RGPD-REGISTRE.md` | Seulement si Rydar héberge le site ou traite des données publicitaires. |
| `docs/EN-COURS.md`, `docs/HISTORIQUE.md`, `docs/FLOTTE-PRIVEE.md` | Avancement des lots ; historique. |

---

## 13. Tests

### 13.1 Base de données (vitest sur PostgreSQL réel)

Aides ajoutées à `tests/db/helpers.ts` (ajouts seulement) : `superAdmin()` (compte `is_super_admin`) et
`createPrivateFleet(name, opts)` (compte neuf + `svc_platform_create_private_fleet`).

**`tests/db/private-fleet.test.ts`**

1. *Schéma et droits* : `private_fleet` à `false` pour une organisation standard ; `select *` par le propriétaire
   accepté ; UPDATE de `private_fleet` par le propriétaire → 42501 ; UPDATE en service role sans RPC →
   `PRIVATE_FLEET_LOCKED` ; marqueur posé + `dispatch_model 'centrale'` → `PRIVATE_FLEET_MODEL`.
2. *Création* : organisation (`private_fleet`, `fleet`, lien fermé), propriétaire actif, véhicule, fiche (`owner_driver`,
   `trusted`, même compte), profil = `PRIVATE_FLEET_DISPATCH_PROFILE`, `platform_fee_changes` « initial », audit avec la
   référence du contrat ; refus : acteur non super admin (42501), `SELF_NOT_ALLOWED`, `ALREADY_REGISTERED`,
   `OWNER_NOT_NEW` (adhésion existante ; compte de plus d'une heure), `PRIVATE_FLEET_PLAN_INVALID`, `SLUG_TAKEN`,
   `SUBDOMAIN_RESERVED`, `CONSENT_REQUIRED`, `INVALID` (ville absente, saisie invalide) ; taux invalide (60 %) →
   **rien d'écrit** (ni organisation, ni adhésion, ni e-mail en file).
3. *Limites* : `org_limits` = `max_drivers` 1, `max_admins` 1 malgré une offre illimitée et
   `limits_override {"max_drivers": 50, "max_admins": 10}` ; organisation standard identique à la formule de `002800`.
4. *Gardes* : 2e fiche (service role) → `PRIVATE_FLEET_SINGLE_DRIVER` ; candidat inactif inséré → même code ;
   `svc_driver_apply` → `JOIN_DISABLED` ; fiche d'un autre compte → `PRIVATE_FLEET_DRIVER_OWNER` ; `set_join_link(true)` →
   `PRIVATE_FLEET_RESTRICTED`, régénération seule acceptée ; `svc_join_info` → `JOIN_LINK_INVALID` ;
   `set_network_settings` (partage) et `svc_network_approve` → `PRIVATE_FLEET_RESTRICTED` ; `svc_platform_set_fees`
   vers `centrale` → `PRIVATE_FLEET_MODEL` ; 2e adhésion → `PLAN_LIMIT_ADMINS` ; `delete_driver_account` de la fiche →
   accepté (`user_id` nul), puis `svc_platform_attach_private_fleet_driver` recrée la fiche.
5. *Bascule* : sortie avec note → drapeau faux, profil standard, limites de l'offre, 2e chauffeur et 2e membre acceptés,
   lien ouvrable, audit, `realtime.messages` contient `platform.updated` (`model`) sur `org:{id}` et `driver.updated` sur
   `driver:{id}` ; sans note → `CONSENT_REQUIRED` ; vers `centrale` → modèle changé, répartition calculée ; refus de
   `svc_platform_set_fees` (ex. `TERMS_NOT_NOTIFIED`) → **rien d'écrit** (toujours Flotte Privée) ; nombres de courses,
   fiches, clés API et écritures de frais identiques avant et après ; entrée refusée avec 2 fiches, 2 membres, fiche
   d'un autre compte, candidature, partage réseau ou modèle centrale (liste des raisons), acceptée sinon.
6. *Exemption (007700)* : en centrale après bascule, course terminée par la fiche du gérant → aucun `ride_settlements` ;
   course d'un autre chauffeur → règlement créé (non-régression).

**`tests/db/private-fleet-dispatch.test.ts`**

1. Réservation immédiate par l'API (insertion service role, `source api`), chauffeur hors ligne sans position à 200 km :
   une offre `fleet` pending, échéance ≈ maintenant + 300 s, course `OFFERED`, notification `ride_offer` « NOUVELLE
   RÉSERVATION » (`kind private_new`), aucune offre `geo`.
2. Planifiée à J+3 : échéance = prise en charge − 60 min ; `ride_offer_scheduled` ; rappels aux heures attendues
   (`kind private_reminder`, 4 au plus, aucun avant maintenant + 20 min) ; planifiée dans 70 min → `ride_offer`.
3. Acceptation → `ACCEPTED`, rappels « à confirmer » annulés, `ride_reminder` programmés.
4. Refus → `NO_DRIVER_FOUND` immédiat, `dispatch.private_declined`, aucune notification `ride_unconfirmed`, aucun
   `dispatch.explain` ; refus d'une offre déjà expirée → rien.
5. Sans réponse (échéance et `next_dispatch_at` mis dans le passé) → tick : vague GPS (hors ligne : aucune offre) →
   tick après le délai : `NO_DRIVER_FOUND` + `ride_unconfirmed` **sans** `data.ride_id`, avec `booking_id`.
6. Dernier appel : chauffeur en ligne à 80 km, position récente → offre `geo` (rayon 100 km), notification `ride_offer`.
7. Catégorie `van` pour un véhicule `business` : aucune offre, `ride_unconfirmed` (`reason to_check`), course en
   recherche ; `driver_take_ride` → `ACCEPTED`, `ride_assigned` vers lui annulé.
8. Réservation saisie par le propriétaire (insertion en `authenticated`) → `ACCEPTED` d'office, aucune offre, aucun
   `ride_assigned` en file.
9. `driver_take_ride` : réservation à confirmer (« Je la prends » sur le web) → offre acceptée, aucun `ride_assigned` ;
   sur `NO_DRIVER_FOUND` → `ACCEPTED`, `ride_assigned` vers lui annulé ; course d'une autre organisation →
   `RIDE_NOT_FOUND` ; organisation standard → `PRIVATE_FLEET_ONLY` ; plus de 6 h après l'heure → `RIDE_TOO_LATE` ;
   immédiate pendant une course → `ACCEPTED`, `current_ride_id` inchangé, enchaînée à la fin.
10. `auto_dispatch` mis à faux par le propriétaire → l'offre part quand même.
11. Fiche suspendue → `NO_DRIVER_FOUND` immédiat (`dispatch.private_no_driver`).
12. Vol retardé (`apply_flight_status`) → échéance recalculée, anciens rappels annulés, nouveaux posés.
13. Suspension (`set_driver_status`) et bannissement de la fiche pendant une course acceptée → acceptés (D13).
14. Compatibilité 1.1.0 : l'offre apparaît dans `driver_offers_v2`.
15. Non-régression : flotte standard, course immédiate → vagues GPS 4 → 16 km inchangées.

**`tests/db/private-fleet-agenda.test.ts`**

Plage nulle, inversée ou > 62 jours → `AGENDA_RANGE_INVALID` (22023) ; `anon` → refus d'exécution ; fiche inactive →
`FORBIDDEN` ; Flotte Privée : courses `COMPLETED` de plus de 24 h renvoyées (membre), `unassigned` rempli avec
`offer_id`, `offer_expires_at`, `state` corrects ; chauffeur standard non membre : course close depuis plus de 24 h
exclue, `unassigned` nul ; jamais une course d'une autre organisation ; limites 500 et 100.

**Non-régression** : toutes les suites existantes passent **sans modification** (`dispatch`, `accept`, `audit-dispatch`,
`expire-rides`, `fleet-join`, `limits`, `rls`, `audit-droits`, `audit-comptes`, `centrale`, `fleet-platform-fees`,
`platform-fee-schedule`, `shared-network-*`, `webhooks`, `account-deletion`…).

### 13.2 Tests unitaires (`pnpm test`)

| Fichier | Contenu |
|---|---|
| `packages/shared/src/agenda.test.ts` | grille de mois commençant le lundi ; mois commençant un dimanche ; février bissextile (2028) ; semaine du passage à l'heure d'hiver (25/10/2026, Europe/Paris, journée de 25 h) ; regroupement près de minuit ; `dayLayout` et chevauchements ; `agendaKind` pour chaque statut ; `fetchWindow` ≤ 44 jours (borne SQL : 62). |
| `packages/shared/src/private-fleet.test.ts` | schémas (création, bascule, clé du site, réglages de réservation) ; profil dans les bornes SQL (`000200:72-82`, `003200:35-38`) ; `privateFleetBookingState`. |
| `packages/shared/src/private-fleet-sql.test.ts` | SQL = `@rydar/shared` (modèle : `network-sql.test.ts`) : profils posés par les RPC = constantes ; titres des notifications ; règles des rappels ; la **dernière** définition de `private.start_dispatch` appelle `private.private_fleet_dispatch(` et celle de `private.org_limits` contient la clause Flotte Privée (garde-fou pour toute redéfinition future). |
| `migrations.test.ts`, `error-messages.test.ts` | automatiques (numéros, « Dernière définition », libellés). |
| `apps/worker/src/push/push.test.ts` | `ride_unconfirmed` → canal `ride-updates`, niveau « active ». |
| `apps/web/components/shell/dashboard-nav.test.ts` | menu standard figé (instantané) ; menu Flotte Privée exact ; « Frais Rydar » conditionnel. |
| `apps/web/components/shell/private-fleet-guards.test.ts` | chaque page interdite appelle sa garde ; chaque action listée appelle `refuseInPrivateFleet`. |
| `apps/web/lib/*.test.ts` (lots L2, L3, L4) | `checkoutPlanAllowed({privateFleet, plan, orgPlanId})` ; aides du formulaire de création ; API : devis = réservation, `PRICE_CHANGED`, limites par IP, portée `rides:quote` d'une clé navigateur. |
| `apps/driver/src/lib/agenda-view.test.ts`, `offer-urgency.test.ts` | modèle de vue, couleurs, libellés `frTypo`, textes d'accessibilité ; urgence d'une offre Flotte Privée. `planning.test.ts` inchangé. |

### 13.3 Bout en bout (pile locale complète, Chromium)

1. Le super admin crée un client Flotte Privée (option mot de passe si la pile locale n'envoie pas d'e-mail).
2. Le client active son accès, accepte CGV et DPA ; menu Flotte Privée ; URL interdites redirigées ou en 404.
3. Le super admin crée la clé du site (navigateur, origine de test).
4. `POST /api/v1/quotes` puis `POST /api/v1/rides` depuis l'origine autorisée avec `expected_price_cents`.
5. App (export web) : notification en base, offre visible, « Confirmer » ; l'agenda (Mois, Jour) la montre ; webhook
   `ride.accepted` en file.
6. Une 2e réservation laissée sans réponse devient « Non confirmée », puis « La prendre ».
7. Agenda web : vues mois et jour.
8. Bascule en flotte : menu standard, ajout d'un 2e chauffeur ; puis en centrale avec la note ; course du gérant sans
   règlement.
9. Retour en Flotte Privée refusé (2 fiches).

Recette du 10/10/2026 (lot L7) : les 9 étapes passent sur la pile locale (base neuve, web en build de production,
worker, app en rendu web, Chromium) ; détail, contrôles et captures dans `docs/EN-COURS.md`.

---

## 14. Risques et parades

| # | Risque | Parade |
|---|---|---|
| R1 | Redéfinition de `start_dispatch` : toutes les courses de la plateforme y passent. | Corps recopié au caractère près, une branche conditionnée ; suites `dispatch`, `accept`, `audit-dispatch`, `shared-network-*` ; test SQL = shared sur la branche ; relecture par diff contre `000400:335`. |
| R2 | Chauffeur injoignable (téléphone éteint, notifications refusées) : réservations « Non confirmées ». | Rappels ; bandeau « notifications désactivées » dans l'app ; bloc « À traiter » sur le web ; webhooks pour que le site prévienne le client ; échéance réglable ; « La prendre » après coup. |
| R3 | Clé navigateur publique : réservations factices et sonneries en rafale. | Clé serveur recommandée ; limites par IP et par téléphone ; champ piège côté site ; révocation par le super admin. |
| R4 | Catégorie ou places incompatibles envoyées par le site. | Site limité à sa catégorie ; notification « À VÉRIFIER » ; « La prendre » sans contrôle de catégorie. |
| R5 | Compte existant ou mot de passe connu de l'équipe. | Phase 1 : adresse existante refusée (web + `OWNER_NOT_NEW` en base) ; invitation par défaut ; option mot de passe signalée. |
| R6 | Retrait du drapeau sans offre : plus aucune limite. | Le dialogue impose de choisir une offre ou de l'assumer explicitement. |
| R7 | Passage en centrale : effets financiers. | Note obligatoire, récapitulatif, `007700` livrée avec `007600`, règles de hausse existantes. |
| R8 | Ordre de déploiement : web avant la migration → `select` de `loadSession` en erreur (colonne absente), tableau de bord en panne. | Migrations d'abord (`deploy/migrate.sh`) ; l'app tolère l'absence de la clé. |
| R9 | Apps 1.1.0 sans la mise à jour : pas de plein écran pour une immédiate, Messages et Réseau visibles. | Sonnerie quand même ; refus serveur ; EAS Update avant le premier client. |
| R10 | Collision avec la branche `copilot` (migration et fichiers de l'app : `(app)/_layout.tsx`, `profile.tsx`, `offer/[id].tsx`, `app.config.ts`). | Numéros 007600-007700 réservés ; renumérotation du copilote ; module natif hors build stores sans décision. |
| R11 | Suppression de la fiche depuis l'app : réservations Non confirmées. | Texte explicite dans l'app ; I2 pour recréer ; alerte web. |
| R12 | Rappels la nuit (ex. 3 h avant une prise en charge à 6 h). | Mêmes règles que les rappels de course existants ; plage de silence à décider (§ 16). |
| R13 | Notification `ride_offer_scheduled` limitée à 1 h de durée de vie (téléphone éteint plus longtemps). | Rappels suivants ; agenda et accueil web. |
| R14 | Juridique : prestations hors logiciel (site, publicité) en contradiction avec CGV art. 1, 3, 4, 8, 14. | Conditions particulières et contrat de prestations signés avant activation (référence obligatoire). |
| R15 | Confusion « Flotte Privée » (pack) / « RYDAR Privé » (site externe déjà relié). | Décision de nom (§ 16). |
| R16 | Contention du verrou consultatif par organisation (garde D). | Pris seulement pour une Flotte Privée, le temps d'une insertion de fiche. |

---

## 15. Lots

Ordre : **L1** d'abord ; puis **L2, L3, L4, L5 en parallèle** (chemins disjoints) ; **L6** ; **L7**. Règles pour tous :
ne modifier que les chemins autorisés ; pas de commit ni de push sans demande ; base de test dédiée pour
`pnpm test:db` (`TEST_DATABASE_NAME=…`) ; PostgreSQL local : `pg_ctlcluster 16 main start`.

| Lot | Titre | Dépend de | Statut |
|---|---|---|---|
| L1 | Socle base de données, paquet partagé et worker | — | fait : `89b8401` ; revue : `dfc4f71` (SQL), `8e93b18`, `53394fb` |
| L2 | Super admin (création, clé du site, bascule, passerelle contacts) | L1 | fait : `2b94c88` ; revue : `8e93b18` (admin et API), `53394fb` (conformité) |
| L3 | Espace web du client Flotte Privée (menu, accueil, agenda web, gardes) | L1 | fait : `915f34b` ; revue : `df83c0e` (web du client) |
| L4 | API v1 du site (devis, prix attendu, limites par IP) + `docs/API.md` | L1 | fait : `df72170` ; revue : `8e93b18` (débit des clés, limite du site) |
| L5 | App chauffeur (Flotte Privée, agenda) | L1 | fait : `106dbc1` ; revue : `695f23a` (app) |
| L6 | Documentation | L1 à L5 | fait : commit « Flotte Privée (lot 6) : documentation » |
| L7 | Recette de bout en bout et contrôle final | L1 à L6 | fait : commit « Flotte Privée (lot 7) : recette de bout en bout et contrôle final » (9 étapes du § 13.3 OK ; corrigés : sous-titre « Flotte Privée », fiche transmise par `getOrgContext`, textes de la clé navigateur) |

Écarts entre la spécification et le code livré : § 15.1, après la description des lots.

### L1 — Socle base de données, paquet partagé et worker

- **Périmètre** : § 3, § 4 (`007600`, `007700`), § 6 (type worker), constantes et logique partagées (Annexe B), tests
  du § 13.1 et des fichiers partagés du § 13.2.
- **Chemins autorisés** : `supabase/migrations/20260924007600_private_fleet.sql`,
  `supabase/migrations/20260924007700_private_fleet_owner_settlements.sql`, `tests/db/private-fleet.test.ts`,
  `tests/db/private-fleet-dispatch.test.ts`, `tests/db/private-fleet-agenda.test.ts`, `tests/db/helpers.ts` (ajouts
  seulement), `packages/shared/src/**`, `apps/worker/src/push/types.ts`, `apps/worker/src/push/push.test.ts`.
- **Critères d'acceptation** :
  1. Les deux migrations existent ; `migrations.test.ts` passe (numéros uniques ; « Dernière définition » avec numéro
     complet pour `org_limits` → `20260924002800`, `start_dispatch` → `20260924000400`, `driver_home` → `20260924006900`,
     `driver_account_state` → `20260924007400`, `sync_ride_settlement` → `20260924006900`).
  2. `error-messages.test.ts` passe : tous les codes de l'Annexe A ont un libellé.
  3. Les trois fichiers `tests/db/private-fleet*.test.ts` couvrent les scénarios du § 13.1 et passent.
  4. Toutes les suites DB existantes passent sans modification.
  5. Migrations + seed sur base neuve : 29 chauffeurs et 3 organisations.
  6. `@rydar/shared` exporte `agenda.ts` et `private-fleet.ts` (Annexe B), les types `DriverHome`
     (`organization.private_fleet?`, `driver.owner_driver?`, `private?`), `DriverAccountState`
     (`organization.private_fleet?`), `DriverAgenda`, `AgendaBooking`, et les changements d'API (`rides:quote`,
     `BROWSER_KEY_SCOPES`, `expected_price_cents`, `apiQuoteSchema`, libellé de portée) ; `private-fleet-sql.test.ts` passe.
  7. Worker : `ride_unconfirmed` sur le canal `ride-updates` (test).
  8. `pnpm typecheck` passe sur tout l'espace de travail (types ajoutés optionnels : web et app compilent sans changement).
- **Commandes de contrôle** :
  - `pnpm typecheck`
  - `pnpm test`
  - `TEST_DATABASE_NAME=rydar_test_pf pnpm test:db`
  - `PGPASSWORD=postgres DB_NAME=rydar_pf_seed bash scripts/db-local.sh --reset --seed`
  - `test "$(PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d rydar_pf_seed -tAc 'select count(*) from public.drivers')" = "29"`
  - `test "$(PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d rydar_pf_seed -tAc 'select count(*) from public.organizations')" = "3"`
  - `pnpm --filter @rydar/worker build`

### L2 — Super admin

- **Périmètre** : § 8 et § 9.4 ; refus Flotte Privée de `grantOrganizationAccess`, du choix de modèle et des actions de
  clés et webhooks du tableau de bord (D16) ; extraction de `insertKey`.
- **Chemins autorisés** : `apps/web/app/admin/**`, `apps/web/components/admin/**`, `apps/web/lib/api-keys-server.ts`
  (nouveau), `apps/web/lib/private-fleet-admin.test.ts` (nouveau), `apps/web/app/dashboard/integrations/actions.ts`
  (import de `insertKey` + refus Flotte Privée, en lisant `organizations.private_fleet` lui-même).
- **Critères d'acceptation** :
  1. « Nouveau client Flotte Privée » crée le client par invitation + RPC ; adresse existante refusée avec un message
     clair ; en cas d'échec de la RPC, le compte Auth créé est supprimé.
  2. Badge et filtre « Flotte Privée » dans la liste.
  3. Fiche : carte Flotte Privée (état), clé serveur ou navigateur créée seulement après CGV/DPA, affichée une fois,
     révocable ; « Recréer la fiche chauffeur » ; bascule vers flotte ou centrale par le dialogue (note obligatoire,
     erreurs de la RPC affichées) ; choix de modèle désactivé ; accès et réseau masqués ; offre sans API refusée.
  4. Organisation standard : « Passer en Flotte Privée » avec préconditions indicatives.
  5. `/admin/contacts/[id]` (`eligibility`) : création préremplie, demande marquée traitée.
  6. Tableau de bord d'une organisation standard : création et rotation de clés inchangées.
  7. Flotte Privée : les actions de clés et de webhooks de `integrations/actions.ts` renvoient
     `PRIVATE_FLEET_RESTRICTED` (test statique dans `lib/private-fleet-admin.test.ts`).
- **Commandes de contrôle** : `pnpm typecheck` ; `pnpm test` ; `pnpm --filter @rydar/web build`.

### L3 — Espace web du client

- **Périmètre** : § 7 en entier (dont l'agenda web), § 7.6 (Checkout).
- **Chemins autorisés** : `apps/web/lib/auth.ts`, `apps/web/lib/private-fleet.ts` (nouveau),
  `apps/web/lib/private-fleet.test.ts` (nouveau), `apps/web/app/dashboard/**` **sauf**
  `apps/web/app/dashboard/integrations/actions.ts`, `apps/web/components/shell/**`, `apps/web/components/private-fleet/**`
  (nouveau), `apps/web/components/agenda/**` (nouveau), `apps/web/components/rides/**`, `apps/web/components/settings/**`,
  `apps/web/components/drivers/**`, `apps/web/components/charts/**`, `apps/web/components/alerts/**`,
  `apps/web/app/api/billing/**`.
- **Critères d'acceptation** :
  1. `OrgSummary.private_fleet` et `driverId` disponibles ; organisation standard : menu identique (instantané).
  2. Menu Flotte Privée exactement conforme au § 7.2.
  3. Pages et actions du § 7.4 redirigées / en 404 / refusées (test statique) ; `createDriver` et `inviteMember` refusent
     avant toute création de compte.
  4. Accueil, Agenda (4 vues, fuseau de l'organisation, passage à l'heure d'hiver), Réservations, Mon site, Mon profil
     chauffeur, Réglages (onglet Réservations enregistré) conformes au § 7.3.
  5. Checkout : une Flotte Privée ne peut payer que l'offre attribuée (test de la fonction pure).
  6. Layout sans lectures inutiles en Flotte Privée.
  7. `dashboard-links.test.ts` passe ; aucune régression des pages standard.
- **Commandes de contrôle** : `pnpm typecheck` ; `pnpm test` ; `pnpm --filter @rydar/web build`.

### L4 — API v1 du site

- **Périmètre** : § 11.
- **Chemins autorisés** : `apps/web/app/api/v1/**`, `apps/web/lib/api/**`, `apps/web/lib/booking-price.ts`,
  `apps/web/lib/api-v1-*.test.ts` (nouveaux), `docs/API.md`.
- **Critères d'acceptation** :
  1. `POST /api/v1/quotes` (portée `rides:quote`, clé navigateur permise) renvoie le prix de `bookingSitePrice`.
  2. `expected_price_cents` différent → 409 `PRICE_CHANGED` avec le nouveau prix, rien de créé ; absent → comportement
     inchangé.
  3. Clés navigateur : limites par IP et par téléphone, 429 + `Retry-After` ; clés serveur inchangées.
  4. Portée d'une clé navigateur contrôlée par `BROWSER_KEY_SCOPES`.
  5. `docs/API.md` décrit l'intégration d'un site Flotte Privée.
- **Commandes de contrôle** : `pnpm typecheck` ; `pnpm test` ; `pnpm --filter @rydar/web build`.

### L5 — App chauffeur

- **Périmètre** : § 10.
- **Chemins autorisés** : `apps/driver/app/**`, `apps/driver/src/**` — **jamais** `apps/driver/app.config.ts`,
  `apps/driver/eas.json`, `apps/driver/package.json`, `apps/driver/plugins/**`.
- **Critères d'acceptation** :
  1. Aucun changement natif ; `export:check` passe.
  2. `privateFleet` et `ownerDriver` dérivés de `driver_home` / `driver_account_state` ; clé absente = standard.
  3. Accueil, Profil, gardes d'écrans, texte de suppression conformes aux § 10.3 et 10.4 ; bandeau notifications.
  4. Agenda : 4 vues, défauts (Liste standard, Mois Flotte Privée), bloc « À traiter », actions Confirmer / Refuser /
     La prendre / Annuler / Appeler, repli `withLegacy`, aucun nouveau stockage, aucun `new Intl` au rendu.
  5. Écran d'offre : titre, « La prendre à la suite », avertissement véhicule, urgence Flotte Privée.
  6. Routage de `ride_unconfirmed` vers l'agenda.
  7. Chauffeur standard : Planning inchangé par défaut (note App Review valable).
- **Commandes de contrôle** : `pnpm typecheck` ; `pnpm test` ; `pnpm --filter @rydar/driver export:check`.

### L6 — Documentation

- **Périmètre** : § 12.3 (sauf `docs/API.md`, fait par L4).
- **Chemins autorisés** : `CLAUDE.md` (une ligne, texte soumis au propriétaire), `docs/ARCHITECTURE.md`,
  `docs/SECURITY.md`, `docs/DEPLOYMENT.md`, `docs/STORES.md`, `docs/RGPD-REGISTRE.md`, `docs/EN-COURS.md`,
  `docs/HISTORIQUE.md`, `docs/FLOTTE-PRIVEE.md`.
- **Critères d'acceptation** : chaque document décrit le comportement livré (pas celui prévu) ; aucun prix ni clause
  inventés ; procédure de création et ordre de déploiement dans `DEPLOYMENT.md` ; statuts des lots à jour ici.
- **Commandes de contrôle** : `pnpm test` ; `git diff --name-only` limité aux chemins autorisés.

### L7 — Recette de bout en bout et contrôle final

- **Périmètre** : scénario du § 13.3 sur la pile locale ; contrôle complet ; rapport. Tout défaut est corrigé dans le
  lot propriétaire du fichier (rouvert), jamais ici.
- **Chemins autorisés** : `docs/EN-COURS.md`, `docs/FLOTTE-PRIVEE.md` (statuts et compte rendu).
- **Critères d'acceptation** : les 9 étapes du § 13.3 passent ; toutes les commandes ci-dessous passent ; compte rendu
  dans `docs/EN-COURS.md`.
- **Commandes de contrôle** :
  - `bash scripts/local-stack/setup.sh` (recrée la base `rydar` + seed) puis `bash scripts/local-stack/start.sh`
  - `pnpm dev`, `pnpm dev:worker`, `pnpm --filter @rydar/driver web`
  - `pnpm typecheck`
  - `pnpm test`
  - `TEST_DATABASE_NAME=rydar_test_e2e pnpm test:db`
  - `pnpm build`
  - `pnpm --filter @rydar/driver export:check`

### 15.1 Écarts entre la spécification et le code livré

Relevés dans les comptes rendus des lots et vérifiés dans le code ; le code fait foi. Les sections citées gardent le texte
d'origine.

**Base (`007600`, § 4.3)**

- Garde D : toute insertion d'une fiche alors qu'une autre n'est pas supprimée est refusée, même sans compte
  (`user_id` nul) ; seul le détachement (UPDATE à `user_id` nul) passe sans contrôle. Drapeau lu sous le verrou de la
  ligne de l'organisation (`for no key update`) au lieu d'un verrou consultatif.
- Nouvelle garde `organization_users_private_fleet_guard` : une 2e adhésion non désactivée (insertion, réactivation,
  invitation acceptée) → `PRIVATE_FLEET_RESTRICTED` ; pour une insertion ou une réactivation, `PLAN_LIMIT_ADMINS`
  (`org_limits`) répond d'abord.
- Garde E : verrou consultatif partagé (exclusif à l'entrée en Flotte Privée). `set_network_settings`,
  `svc_network_approve` et `svc_network_suspend` commencent par une insertion « on conflict do nothing » qui déclenche
  la garde : elle ne passe que si l'adhésion existe, donc `svc_network_suspend` sur une Flotte Privée **sans** adhésion
  répond `PRIVATE_FLEET_RESTRICTED` (message clair sur `/admin/reseau`).
- G, étape 5, et H : la notification initiale (« NOUVELLE RÉSERVATION », sonnerie à 15 min ou moins) est posée par le
  déclencheur **H4** pour toute offre de la Flotte Privée, même recréée par le moteur ; **H5** (déclencheur différé,
  `private.private_fleet_hold`) repousse le passage du tick à l'échéance annoncée quand la fenêtre de la flotte se
  fermerait avant (délai de réponse de plus de 5 min, délai de confirmation allongé, bascule) ; **H6** réagit aux
  réglages « Réservations » (échéances tenues, rappels replanifiés en gardant ceux déjà prévus ou dus). Rappels calculés
  par `private.private_fleet_plan_reminders` (H1, H6), annulés d'abord même hors Flotte Privée.
- I1 : refus `INVALID` (nom commercial, identifiant, ville obligatoire, fiche, véhicule) et `NOT_FOUND` (compte) ; taux
  nuls ramenés à 0 ; réponse avec `fees` ; audit avec `owner_email` et `fees_code`.
- I2 : refus `INVITATION_PENDING` (propriétaire encore invité), `ALREADY_REGISTERED`, `INVALID` ; plaque déjà connue de
  l'organisation : véhicule repris.
- I3 : paramètres `p_set_plan` / `p_plan_id` (offre de la sortie écrite après le drapeau, dans le même sous-bloc que les
  frais ; audit `organization.plan_changed` en SQL) ; `INVALID` pour une entrée avec modèle, taux ou offre, ou pour un
  état inchangé avec modèle ou taux ; `ORGANIZATION_INACTIVE` seulement pour une organisation archivée ; réponse avec
  `open_rides`. Courses en recherche : une offre en attente garde son échéance (aucun `next_dispatch_at = now()`), les
  autres repartent au passage suivant ; entrée : course en vagues GPS reprise à la vague 0 ; sortie : rappels « à
  confirmer » en file annulés.
- J1 : `UNCHANGED` renvoie aussi `ride_id`. Annexe A : `ORGANIZATION_INACTIVE` n'avait pas de libellé, il a été
  ajouté à `ERROR_MESSAGES`.
- Worker : regroupement iOS d'une `ride_unconfirmed` par `data.booking_id`.

**API v1 (§ 11, lot L4 et revue)**

- Limites d'une clé navigateur comptées **par organisation** (un visiteur abusif d'un site ne bloque pas les autres) ; en
  plus, 60 réservations par heure pour l'organisation (toutes ses clés navigateur), vérifiée après la limite par
  téléphone ; limite par téléphone comptée après la résolution des lieux.
- Débit d'une clé navigateur compté à part pour les devis et pour les réservations ; réglable à la création de la clé
  du site : clé serveur 60 par minute par défaut, clé navigateur 1 000 par défaut (300 au moins).
- `Idempotency-Key` reconnue avant tout calcul (un renvoi ne répond jamais `PRICE_CHANGED`, ne compte dans aucune
  limite par téléphone ou du site) ; clé serveur avec `price_cents` et `expected_price_cents` différents → 422 ; devis :
  422 `PICKUP_IN_PAST` (plus de 10 min dans le passé) et `PICKUP_TOO_FAR` (plus de 400 jours) ; en-têtes CORS sur les
  refus une fois l'origine vérifiée ; `bookingSitePrice` accepte une destination sans coordonnées (forfait seulement).

**Super admin (§ 8, § 9.4)**

- Création : identifiant, offre et adresse contrôlés **avant** tout compte Auth ; compte créé par
  `createUser({ email_confirm: false })` (preuve qu'il est neuf), puis invitation ; compensation limitée à ce compte,
  sans adhésion ni fiche, jamais sur `OWNER_NOT_NEW`, `ALREADY_REGISTERED`, `SELF_NOT_ALLOWED` ou `NOT_FOUND`.
- « Renvoyer le lien d'accès » (propriétaire jamais connecté ; audit `member.invitation_resent`) ; un seul dialogue
  « Changer d'offre de service » ; entrée en Flotte Privée refusée côté web si l'offre effective n'a pas l'API ; sortie
  sans offre : case « Je l'assume » obligatoire ; `savePlan` refuse de retirer l'API d'une offre utilisée par une Flotte
  Privée non archivée sans surcharge qui la lui rende ; passerelle des demandes : note existante gardée et complétée.

**Espace web du client (§ 7)**

- Refonte des panneaux, lot R8 (`docs/REFONTE-PANELS.md`) : Accueil, Réservations et leur fiche, Agenda, Mon site, Mon
  profil chauffeur et Activité remis en forme sans changer les actions ni les gardes ; le § 7.3 décrit l'état livré
  (« Fixer le prix », annulation depuis la fiche seulement, carte « Mon site » sans la clé).
- § 7.2, sous-titre de la barre latérale : « Flotte Privée » s'affiche sous le nom de l'organisation, à la place du rôle
  (`sidebarOrgCaption`, `components/shell/dashboard-nav.ts`) ; il n'était que l'attribut `title` du logo, invisible
  (corrigé à la recette L7, test dans `dashboard-nav.test.ts`). Organisation standard : rôle affiché, inchangé.
- `driverId` dans la session : `requireOrg` ne le garde que pour l'organisation affichée ; `getOrgContext` le transmet
  tel quel (aucune action ne s'en sert). `checkoutPlanAllowed` dans `app/api/billing/checkout/plan-access.ts` ; Checkout
  en 503 si l'organisation est illisible.
- Agenda ouvert sur « mois » ; Réservations ouvert sur « À traiter » s'il y en a, sinon « À venir » ; « Annulées »
  comprend `NO_DRIVER_FOUND` ; motif d'annulation obligatoire (3 à 280 caractères) ; terminée en vert
  (`AGENDA_KIND_META`), pas en `brand`. `declineOffer` et `updatePrivateBookingSettings` refusés hors Flotte Privée
  (`PRIVATE_FLEET_ONLY`). Pastille de « Réservations » : non confirmées seulement (jamais un refus du chauffeur).
- § 7.6 : `/api/billing/portal` ne choisit aucune configuration de portail Stripe ; celle par défaut sert à toutes les
  organisations, et c'est par elle qu'une organisation déjà abonnée change d'offre. La régler « sans changement
  d'offre » vaut donc pour toutes (choix décrit dans `docs/DEPLOYMENT.md` § 4, étape 6).

**App chauffeur (§ 10)**

- Détection : `driver_home` prime, `driver_account_state` seulement si l'accueil est illisible. Vue Liste : « Mes
  courses » lues par `driver_rides_upcoming` (comme avant) ; `driver_agenda` alimente Jour, Semaine, Mois et « À
  traiter ». Puce « Aujourd'hui » en Jour, Semaine et Mois seulement ; horloge de l'écran à 30 s.
- Écran d'offre : une réservation urgente (15 min au plus) sonne et garde son compte à rebours mais reste différable
  (« Plus tard », retour Android) ; seules les offres GPS et les fenêtres de 2 min au plus restent bloquantes ; refus
  confirmé comme dans l'agenda.
- Fiche du gérant : prix affiché partout (offres, course, gains, agenda), ni commission ni net par course, même après
  une bascule en centrale. Suppression du compte : textes propres à la Flotte Privée (fiche et données supprimées,
  compte et espace web gardés).

---

## 16. Décisions qui reviennent au propriétaire

Valeurs « proposé » = défaut technique retenu dans cette spécification, modifiable sans refonte.

1. **Prix et facturation du pack** : abonnement, frais de mise en place du site et des comptes, frais de gestion des
   campagnes, frais Rydar par course pour ce pack (0 au départ ?). Stripe (offre non publique créée dans `/admin/plans`,
   portail configuré sans changement d'offre) ou facture manuelle. Aucun prix n'est proposé ici.
2. **Contrat** : rédaction et relecture par un avocat des conditions particulières et du contrat de prestations ; mode
   de signature (électronique, hors application) ; plus tard, acceptation en ligne (§ 12.2) ; faut-il une phrase dans
   les CGV (nouvelle `ORG_LEGAL_VERSION` après le 2026-11-05) ?
3. **Points juridiques** : mandat d'achat d'espace (loi Sapin), droit de rétractation (L221-3), règles Google et Meta
   pour les gestionnaires tiers, propriété et réversibilité du site, du domaine et des comptes.
4. **Hébergement du site** du client (le client, Rydar ou un prestataire) et accès aux données de conversion : décide
   des mises à jour de `/dpa`, `/confidentialite`, `/mentions-legales` et du registre.
5. **Prix sur le site** : prix ferme (devis de l'API, « Réserver avec obligation de paiement ») ou demande sans prix.
6. **Réservations « maintenant »** sur le site : autorisées (proposé : oui, délai de réponse 5 min) ou délai minimal
   imposé par le site.
7. **Délais par défaut** : confirmation au plus tard 60 min avant (proposé), délai de réponse d'une immédiate 5 min
   (proposé), rappels selon `{1440,180,60,30}` + dernier rappel 30 min avant l'échéance (proposé) ; plage de silence
   nocturne ?
8. **Refus** : réservation « Refusée » tout de suite (proposé) ou attente de l'échéance.
9. **Réglages par le chauffeur** (onglet « Réservations ») : proposé oui (confirmation, délai, rappels, paiement).
10. **Agenda** : vues Jour / Semaine / Mois pour tous les chauffeurs (proposé, Liste par défaut hors Flotte Privée) ;
    entrée « Agenda » dans le menu web des flottes et centrales ?
11. **Compte existant** du client : refusé en phase 1 (proposé) ; phase 2 = invitation puis fiche créée après
    activation (I2).
12. **Clés API et webhooks** : gérés par l'équipe (proposé, D16) ou par le client.
13. **Justificatifs** : Rydar vérifie-t-il carte VTC, assurance et inscription au registre avant de créer la clé du
    site ?
14. **Passage en centrale** : exemption de règlement du gérant (proposé, `007700`).
15. **Promesses de `/eligibilite`** : retirer « suivi des réservations venues de tes pubs » ou prévoir un champ
    d'attribution (canal, campagne) transmis par le site ; garder « 15 places » exact.
16. **Nom commercial** : « Flotte Privée » à côté de « RYDAR Privé » (site externe existant).
17. **Démonstration** : organisation Flotte Privée dans le seed (les compteurs de la CI, 29 chauffeurs et 3
    organisations, seraient à changer) ; le compte « Démo App Review » reste une flotte standard (proposé).
18. **Publication** : EAS Update dès que le serveur est prêt, puis 1.2.0 ; sort du copilote (renumérotation de sa
    migration, module natif hors build stores sans décision).
19. **Support** : accès de l'équipe à l'espace du client au-delà des cartes du super admin (aujourd'hui : non,
    `max_admins` 1).
20. **Messagerie** masquée en Flotte Privée (proposé).

---

## Annexe A — Codes d'erreur (libellés à ajouter à `ERROR_MESSAGES`)

| Code | Origine | Libellé proposé |
|---|---|---|
| `PRIVATE_FLEET_LOCKED` | garde C (raise) | « Flotte Privée : changement réservé à l'équipe Rydar. » |
| `PRIVATE_FLEET_MODEL` | garde C (raise) | « Flotte Privée : modèle flotte imposé. Sortez d'abord de la Flotte Privée. » |
| `PRIVATE_FLEET_RESTRICTED` | gardes C, E ; web (raise) | « Fonction non incluse dans la Flotte Privée. » |
| `PRIVATE_FLEET_SINGLE_DRIVER` | garde D (raise) | « Flotte Privée : un seul chauffeur, vous. Pour ajouter des chauffeurs, demandez le passage en flotte à l'équipe Rydar. » |
| `PRIVATE_FLEET_DRIVER_OWNER` | garde D (raise) | « Flotte Privée : la fiche chauffeur doit être celle du propriétaire du compte. » |
| `PRIVATE_FLEET_NOT_ELIGIBLE` | garde C (raise), I3 | « Passage en Flotte Privée impossible : un seul membre (le propriétaire), une seule fiche (la sienne), aucune candidature, aucun réseau partagé, modèle flotte. » |
| `AGENDA_RANGE_INVALID` | J2 (raise) | « Période d'agenda invalide (62 jours au plus). » |
| `PRIVATE_FLEET_ONLY` | I2, J1 | « Réservé à la Flotte Privée. » |
| `PRIVATE_FLEET_PLAN_INVALID` | I1 | « Offre sans accès à l'API : le site du client ne pourrait pas réserver. » |
| `PRIVATE_FLEET_HAS_DRIVER` | I2 | « Cette Flotte Privée a déjà une fiche chauffeur. » |
| `OWNER_NOT_NEW` | I1 | « Compte déjà utilisé : la Flotte Privée exige un compte neuf (phase 1). » |
| `SELF_NOT_ALLOWED` | I1 | « Impossible de vous désigner vous-même. » |
| `SLUG_TAKEN` | I1 | « Ce slug est déjà utilisé. » |
| `ALREADY_REGISTERED` | I1 | « Ce compte est déjà rattaché à une fiche chauffeur. » |
| `RIDE_TOO_LATE` | J1 | « Heure de prise en charge dépassée depuis plus de 6 h. » |

Codes existants réutilisés : `CONSENT_REQUIRED`, `SUBDOMAIN_RESERVED`, `PLAN_LIMIT_ADMINS`, `PLAN_LIMIT_DRIVERS`,
`JOIN_LINK_INVALID`, `JOIN_DISABLED`, `RIDE_NOT_FOUND`, `RIDE_NOT_ASSIGNABLE`, `ORGANIZATION_INACTIVE`, codes de
`svc_platform_set_fees`. L'exception interne `RYD01` (sous-blocs I1 et I3) n'est jamais renvoyée telle quelle.

## Annexe B — Constantes et fonctions partagées (`@rydar/shared`)

`packages/shared/src/private-fleet.ts` :

- `PRIVATE_FLEET_DISPATCH_PROFILE`, `STANDARD_DISPATCH_PROFILE` (§ 3.3 ; le standard reprend `DEFAULT_DISPATCH_RADII_M`
  et `DEFAULT_RETRY_RADII_M`, `domain.ts:185-187`).
- `PRIVATE_FLEET_RING_WINDOW_S = 900` ; `PRIVATE_FLEET_REMINDER_RULES = { minAheadMinutes: 20, lastCallMinutes: 30,
  endMarginMinutes: 5, minGapMinutes: 15, max: 4 }` ; `PRIVATE_FLEET_TAKE_MAX_AGE_HOURS = UNSTARTED_RIDE_EXPIRY_HOURS`.
- `PRIVATE_FLEET_TITLES` (NOUVELLE RÉSERVATION, RÉSERVATION À CONFIRMER, RÉSERVATION NON CONFIRMÉE, RÉSERVATION À
  VÉRIFIER) ; `PRIVATE_FLEET_BOOKING_STATES` (`to_confirm`, `to_check`, `declined`, `not_confirmed`) et leurs libellés
  (« À confirmer », « À vérifier », « Refusée », « Non confirmée ») ; `privateFleetBookingState(…)`.
- `PRIVATE_FLEET_BLOCKERS` et `PRIVATE_FLEET_BLOCKER_LABELS`.
- Schémas : `privateFleetCreateSchema` + `PRIVATE_FLEET_CREATE_LABELS`, `privateFleetSwitchSchema`,
  `privateFleetSiteKeySchema`, `privateBookingSettingsSchema` (choix : confirmation 30 min, 1 h, 2 h, 3 h, 6 h, 12 h,
  24 h ; délai 60, 120, 180, 300, 600 s ; rappels parmi 1440, 720, 180, 120, 60, 30 min ; paiement).

`packages/shared/src/agenda.ts` (pur, sans `formatToParts` ni `zonedTimeToUtc` ; réexporté par `src/index.ts`, aucun
sous-chemin ajouté à `exports`) : `AgendaView`, `addDays`,
`weekStart` (lundi), `monthGrid` (42 jours), `viewRange`, `fetchWindow`, `groupByDay(items, timeZone)`,
`minutesOfDay`, `dayLayout` (blocs, colonnes des chevauchements), `overlaps`, `agendaKind`, `AGENDA_KIND_META`
(libellé, ton), `daySummary`, `dayTitle`, `weekTitle`, `monthTitle` (via `dateTimeFormat`).

`packages/shared/src/schemas.ts` : `API_SCOPES` + `rides:quote`, `API_SCOPE_LABELS["rides:quote"] = "Devis"`,
`BROWSER_KEY_SCOPES = ["rides:create", "rides:quote"]` (message du refus mis à jour), `apiRideCreateSchema` +
`expected_price_cents`, `apiQuoteSchema`.

`packages/shared/src/types.ts` : ajouts optionnels de `DriverHome` et `DriverAccountState` ; `DriverAgenda`,
`AgendaBooking`.

## Annexe C — Références de code vérifiées

| Élément | Référence |
|---|---|
| `start_dispatch` (définition unique) | `000400:335` ; `before_ride_insert` `000400:209` ; `after_ride_insert` `000400:317` |
| `queue_notification` (`p_scheduled_for`), `close_pending_offers`, `schedule_reminders` | `000400:73`, `000400:124`, `000400:156` |
| `org_limits` / `enforce_plan_limits` | `002800:9` / `000700:5` (jamais redéfinie) |
| `own_geo_candidates`, `dispatch_geo_step`, `run_geo_wave`, `offer_to_fleet`, `dispatch_tick` | `006800:573`, `:982`, `:1145`, `:1358`, `:1493` |
| `accept_ride_offer`, `decline_ride_offer`, `assign_ride`, `reassign_ride`, `redispatch_ride`, `apply_flight_status` | `006800:1687`, `:1949`, `:2136`, `:2600` (marqueur `:2684`), `:2823`, `:2910` |
| Appels internes de `reassign_ride` | `006800:3434`, `006800:3615`, `007400:332` |
| `claim_notifications` | `006650:1808` |
| `driver_ride_json`, `driver_rides_upcoming`, `cancel_ride_internal` | `007000:325`, `:679`, `:2525` |
| `driver_home`, `sync_ride_settlement`, `svc_platform_set_fees`, `organizations_dispatch_model_guard` | `006900:1117`, `:472`, `:2539`, `:2513` |
| `driver_account_state` | `007400:472` |
| `set_join_link`, `svc_join_info`, `approve_driver_application` | `006300:28`, `:67`, `:244` |
| `svc_driver_apply`, `set_network_settings`, `svc_network_approve`, `svc_network_suspend`, `delete_driver_account` | `007100:954`, `:580`, `:266`, `:364`, `:1122` |
| RLS `rides_select` (24 h pour le chauffeur) | `006700:1669` |
| Grants `organizations` (lecture par colonne / écriture) | `004300:74-77` / `000300:477`, `003900:228` |
| `broadcast_platform` / `broadcast_driver` | `003100:609` / `007000:2714` |
| `jwt_issued_after` | `005400:854` |
| `migrations.test.ts` (« Dernière définition », 25 lignes, numéro complet) | `packages/shared/src/migrations.test.ts` |
| Web : `OrgSummary` / sélection | `apps/web/lib/auth.ts:11` / `:54` |
| Web : actions de mise en page / menu | `components/shell/dashboard-shell.tsx:157` / `:228` |
| Web : Checkout | `app/api/billing/checkout/route.ts:51` |
| Web : `insertKey` | `app/dashboard/integrations/actions.ts:20` |
| Web : règle des limites en TypeScript | `lib/api/v1.ts:45`, `:95` ; `components/admin/admin-widgets.tsx:216` |
| App : `isUrgentOffer` / ouverture / notifications | `src/hooks/driver-context.tsx:118` / `:495` / `:723` |
| Worker : canaux et durée de vie des offres | `apps/worker/src/push/types.ts:37`, `ttlSeconds` |
