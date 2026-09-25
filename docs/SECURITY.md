# Sécurité et isolation multi-tenant

> Règle d'or : **aucune donnée n'est visible entre deux rattacheurs.** La règle est appliquée **dans la base de données** et **côté serveur**. L'interface ne fait que la refléter.

## Défense en profondeur

| Couche | Mécanisme |
| --- | --- |
| **RLS PostgreSQL** | Activée sur **toutes** les tables, refus par défaut. Chaque policy passe par des fonctions `private.*` (`SECURITY DEFINER`, `search_path=''`) : `member_org_ids()`, `has_org_role()`, `current_driver_id()`, `is_super_admin()`. Une organisation suspendue ou un chauffeur suspendu perd l'accès **immédiatement**. |
| **Droits par colonne** | Les clients ne peuvent modifier que des colonnes listées. `status`, `organization_id`, `driver_id` d'une course ne sont modifiables que par les fonctions du moteur (transitions contrôlées). |
| **Intégrité inter-tenant** | Clés étrangères composites `(organization_id, id)` : une course de A ne peut pas référencer un chauffeur ou un véhicule de B. Le trigger `forbid_org_change` rend `organization_id` **immuable**, même pour un superutilisateur. |
| **Fonctions RPC** | Chaque RPC vérifie explicitement le tenant et le rôle (`assert_org_member`) avant d'agir. `EXECUTE` est révoqué par défaut puis accordé fonction par fonction. |
| **Serveur Next.js** | Validation zod de chaque entrée, contrôle du rôle dans chaque server action. La clé *service role* n'est utilisée que côté serveur (`server-only`), après authentification. |
| **Temps réel** | Canaux privés. Une policy RLS sur `realtime.messages` limite `org:{id}` aux membres de l'organisation et `driver:{id}` au chauffeur concerné. `fleet:{id}` (fil flotte, signalements) est ouvert aux chauffeurs de l'organisation, sans donnée client. |
| **Messagerie** | Lecture par RLS uniquement : un chauffeur ne voit que son fil direct et le fil flotte de **son** organisation. Aucune écriture directe : tout passe par des RPC qui vérifient le tenant et limitent le débit (`PT429`). Le nom de l'auteur est dénormalisé, un chauffeur n'accède donc jamais à la fiche des autres. Les signalements exigent une position ; les votes sont uniques par votant. |
| **Documents chauffeur** | Dépôt dans le stockage limité au dossier `<org>/<chauffeur>/` du chauffeur connecté (policy Storage). Validation par la centrale seulement (`review_driver_document`, auteur et date conservés). |

## Scénario obligatoire : A tente de récupérer une course de B

**« Le rattacheur A modifie `organization_id` pour récupérer une course du rattacheur B. »** Le résultat est toujours un refus :

| Tentative | Résultat |
| --- | --- |
| `UPDATE rides SET organization_id = A WHERE id = <course de B>` avec le JWT de A | 0 ligne : la RLS rend la course de B invisible pour A |
| Modifier `organization_id` d'une de ses propres courses | **42501 → 403** (droits par colonne + trigger d'immutabilité) |
| `INSERT` d'une course avec `organization_id = B` | **42501 → 403** (`FORBIDDEN_TENANT`) |
| `cancel_ride` / `assign_ride` sur une course de B | **42501 → 403** |
| API : `organization_id` dans le corps de `POST /rides` | **403 `FORBIDDEN_TENANT_FIELD`**, audité |
| API : `GET` ou `cancel` d'une course de B avec la clé de A | **403 `FORBIDDEN_TENANT`**, audité avec la gravité *critique* (`security.cross_tenant_access`) |
| Chauffeur de A qui accepte une offre de B | refusé |
| S'abonner au canal temps réel `org:B` | refusé |

Chacune de ces lignes est un test automatisé (`tests/db/rls.test.ts`, lancé par la CI). Côté web, `lib/errors.ts` traduit uniformément l'erreur `42501` en **403 « Accès refusé »**.

## Authentification et sessions

- **Supabase Auth (JWT)**. Aucune inscription publique : les rattacheurs sont créés par le Super Admin, les chauffeurs par leur rattacheur (invitation ou mot de passe).
- **Anti brute force** : 6 tentatives par e-mail et 30 par IP sur 15 min, pour la connexion web comme pour la connexion chauffeur (`/api/auth/driver-login`). Compteurs partagés dans Redis.
- **Révocation de session** : les refresh tokens sont supprimés en base, automatiquement, dans ces cas :
  - un chauffeur est désactivé, suspendu ou supprimé ;
  - un membre est retiré ou désactivé ;
  - une organisation est suspendue.

  Le changement de mot de passe d'un chauffeur et le bouton **« Déconnecter »** déclenchent aussi la révocation. L'accès aux données, lui, est coupé dès la requête suivante par la RLS (`tests/db/sessions.test.ts`).
- L'app chauffeur conserve sa session dans le trousseau sécurisé de l'appareil : SecureStore, avec chiffrement AES de la session complète.

## Clés API

- Format `rdk_live_{préfixe}_{secret}`. Seul un **HMAC-SHA-256** poivré (`API_KEY_PEPPER`) est stocké, dans `api_key_secrets`, une table inaccessible à tout rôle client. La comparaison se fait en temps constant.
- Permissions par clé, date d'expiration, révocation immédiate, débit par minute (Redis), origines autorisées pour le CORS.
- Chaque requête est journalisée (`api_logs`) : clé, statut, durée, code d'erreur, IP.

## Secrets et navigateur

- Le navigateur ne reçoit que l'URL Supabase et la clé **publique** (anon). Les clés service role, Stripe, FCM, APNs et le poivre des clés API restent sur le serveur ou dans le worker.
- En-têtes HTTP : CSP stricte (`frame-ancestors 'none'` hors mini-site), HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- Le mini-site public n'expose aucune donnée. Il crée une course par une action serveur limitée en débit, avec pot de miel et consentement.

## Journal d'audit

`audit_logs` enregistre automatiquement, par trigger, les changements sensibles : organisations, chauffeurs, membres, clés API, réglages. Les gravités *warning* et *critical* sont utilisées pour une suspension, une révocation ou une tentative d'accès inter-tenant. Le Super Admin consulte l'audit de toutes les organisations ; un rattacheur ne voit que le sien.

## Limites des offres

Chauffeurs, courses mensuelles, administrateurs, accès API, mini-site et domaine personnalisé sont vérifiés **par des triggers en base** (`PLAN_LIMIT_*`, `PLAN_FEATURE_*`). Contourner l'interface ne permet pas de les dépasser.
