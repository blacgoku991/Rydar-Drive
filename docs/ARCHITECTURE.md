# Architecture

Rydar Drive repose sur un principe : **la base de données est l'arbitre**. Isolation des organisations, éligibilité des chauffeurs, attribution d'une course et transitions de statut sont codées en SQL (RLS et PL/pgSQL). Les applications (web, worker, app chauffeur) appellent ces fonctions. Elles ne peuvent ni les contourner ni se contredire.

## Composants

| Composant | Rôle | Technologies |
| --- | --- | --- |
| **PostgreSQL / Supabase** | Données, RLS, moteur de dispatch, temps réel, outbox des notifications | PostgreSQL 16, PostGIS 3, Supabase Auth, Realtime (broadcast), Storage |
| **apps/web** | Dashboard rattacheur, Super Admin, API publique v1, mini-site de réservation, facturation | Next.js 16 (App Router, `proxy.ts`), React 19, Tailwind v4, Radix, MapLibre GL, Recharts, @supabase/ssr, Stripe |
| **apps/worker** | Tick du dispatch (expirations, vagues suivantes, escalades), envoi des pushs, ménage | Node 22, `pg` (LISTEN/NOTIFY, `FOR UPDATE SKIP LOCKED`), Expo Push, FCM HTTP v1, APNs HTTP/2 |
| **apps/driver** | Application chauffeur : EN LIGNE / HORS LIGNE, GPS, offres, cycle de course | Expo SDK 57, React Native 0.86, expo-router, expo-location (tâche de fond), expo-notifications, react-native-maps |
| **packages/shared** | Vocabulaire commun : statuts, transitions, catégories, schémas zod (messages FR), formatage | TypeScript, zod 4 |

## Modèle de données

Toutes les tables métier portent `organization_id`. Les relations entre tables d'une même organisation utilisent des **clés étrangères composites** `(organization_id, id)`. Une course de l'organisation A ne peut donc pas référencer, même par erreur, un chauffeur ou un véhicule de B. Le trigger `private.forbid_org_change` interdit en plus de modifier `organization_id` après coup (erreur 42501).

| Domaine | Tables |
| --- | --- |
| Plateforme | `plans`, `organizations`, `organization_settings`, `booking_sites`, `subscriptions`, `invoices`, `audit_logs` |
| Utilisateurs | `users` (miroir de `auth.users`), `organization_users` (rôles `owner` / `admin` / `dispatcher`) |
| Flotte | `drivers`, `vehicles`, `driver_documents`, `driver_devices`, `push_tokens`, `driver_locations` (dernière position, `geography` + GiST), `driver_location_history` |
| Courses | `rides`, `ride_offers`, `ride_assignments`, `ride_events` (timeline + journal du dispatch), `ride_status_history`, `pricing_rules` |
| Intégrations | `api_keys` (métadonnées), `api_key_secrets` (hash HMAC, service role uniquement), `api_logs`, `notifications` (outbox) |

Les paramètres de dispatch sont réglables par organisation (`organization_settings`) :

| Paramètre | Défaut | Effet |
| --- | --- | --- |
| `dispatch_radii_m` | `{3000, 5000, 8000, 12000}` | Rayons successifs des vagues GPS |
| `offer_timeout_seconds` | 30 | Durée de vie d'une offre instantanée |
| `max_search_seconds` | 300 | Au-delà : `NO_DRIVER_FOUND` |
| `max_offers_per_wave` | 25 | Chauffeurs notifiés au plus par vague |
| `instant_threshold_minutes` | 45 | Prise en charge ≤ maintenant + 45 min : course **instantanée**, sinon **planifiée** |
| `scheduled_dispatch_lead_minutes` | 60 | Planifiée encore libre à T-60 min : bascule en recherche GPS |
| `reminder_offsets_minutes` | `{1440, 180, 60, 30}` | Rappels au chauffeur attribué |
| `allow_category_upgrade` | true | Un véhicule de catégorie supérieure peut prendre une course inférieure |
| `location_max_age_seconds` | 180 | Position plus ancienne : chauffeur ignoré |

## Moteur de dispatch

### 1. Création

Qu'elle vienne de l'API, du dashboard ou du mini-site, une course passe par le trigger `before_ride_insert`. Il vérifie l'organisation, qui doit être active et à laquelle l'appelant doit appartenir. Il force la source et le créateur, puis attribue un numéro séquentiel par organisation (`#1928`). Enfin, il classe la course : **instantanée** si la prise en charge a lieu dans le seuil, **planifiée** sinon. Les limites de l'offre (courses par mois) sont vérifiées au même moment.

`after_ride_insert` appelle ensuite `private.start_dispatch`, dans la même transaction.

### 2. Course instantanée : vagues GPS

`private.run_geo_wave` sélectionne les chauffeurs qui remplissent **toutes** ces conditions :

- ils appartiennent à la **même organisation** ;
- ils sont `active` et `available` ;
- leur position a moins de `location_max_age_seconds` ;
- leur véhicule est de catégorie compatible et a assez de places ;
- ils n'ont pas déjà décliné cette course ;
- ils se trouvent à moins de R mètres : `ST_DWithin(driver_locations.location, rides.pickup_location, R)`.

Ils sont triés par distance, dans la limite de `max_offers_per_wave`. S'il n'y a personne dans 3 km, la vague suivante (5 km, puis 8, puis 12) est lancée **immédiatement**, dans la même transaction.

Pour les chauffeurs retenus, le moteur crée dans une seule transaction :

- une ligne `ride_offers` (`pending`, expiration à +30 s) ;
- une notification dans l'outbox ;
- le passage du chauffeur à `offered`.

La course passe à `OFFERED`. La timeline enregistre par exemple : « Recherche GPS — rayon 3 km (vague 1) », « 12 chauffeurs en ligne », « 5 chauffeurs à moins de 3 km », « 5 notifications envoyées ».

Toutes les 2 s, le worker appelle `private.dispatch_tick()`. Cette fonction verrouille les courses dues avec `FOR UPDATE SKIP LOCKED`, ce qui permet de lancer plusieurs workers. Elle expire les offres sans réponse, libère les chauffeurs et relance une vague. Si la recherche dépasse `max_search_seconds`, la course passe à `NO_DRIVER_FOUND`.

### 3. Course planifiée : offre à la flotte

`private.offer_to_fleet` propose la course à toute la flotte éligible de l'organisation (actifs, catégorie compatible, places suffisantes), sans critère de distance. L'offre reste ouverte jusqu'à T-`scheduled_dispatch_lead_minutes`. Si personne ne l'a prise à ce moment, le tick **bascule en recherche GPS**. Quand un chauffeur est attribué, les rappels (24 h, 3 h, 1 h, 30 min) sont programmés dans l'outbox avec `scheduled_for`.

### 4. Acceptation atomique

`public.accept_ride_offer(offer_id)`, appelée par l'app chauffeur avec son JWT, enchaîne :

1. le verrouillage de l'offre, puis de la course (`SELECT … FOR UPDATE`), toujours dans l'ordre **rides → ride_offers → drivers** pour éviter les interblocages ;
2. si la course a déjà un chauffeur ou n'est plus proposée, le retour `{ ok: false, code: "RIDE_ALREADY_ASSIGNED", message: "Course déjà attribuée." }` ;
3. sinon, un *compare-and-set* : `UPDATE rides SET driver_id = … WHERE id = … AND driver_id IS NULL AND status IN ('SEARCHING_DRIVER','OFFERED')` ;
4. l'insertion dans `ride_assignments`, protégée par l'**index unique partiel** `(ride_id) WHERE is_active`, dernier filet de sécurité ;
5. la fermeture des autres offres (`closed`), l'annulation de leurs pushs encore en file et la remise à disposition des autres chauffeurs.

Le test `tests/db/accept.test.ts` lance 10 acceptations simultanées sur la même course : il y a exactement **un** gagnant et neuf réponses « Course déjà attribuée. ».

### 5. Cycle de course

`public.driver_update_ride_status(ride_id, status)` n'accepte que les transitions prévues :

```
ACCEPTED → DRIVER_EN_ROUTE → DRIVER_ARRIVED → PASSENGER_ONBOARD → IN_PROGRESS → COMPLETED
          (Aller au départ)  (Je suis arrivé)  (Client à bord)     (Démarrer)     (Terminer la course)
```

Le rattacheur dispose de `cancel_ride`, `assign_ride` (attribution manuelle) et `redispatch_ride`. Chaque changement est historisé (`ride_status_history`) et raconté dans la timeline (`ride_events`).

## Temps réel

Des triggers publient les changements avec `realtime.send` (Supabase Realtime, canaux **privés**) :

| Topic | Événements | Abonnés |
| --- | --- | --- |
| `org:{organization_id}` | `driver.location`, `driver.updated`, `ride.updated`, `ride.event`, `offer.updated` | Dashboard (carte, listes, timeline) |
| `driver:{driver_id}` | `offer.updated`, `ride.updated`, `ride.unassigned` | App chauffeur |

La policy RLS sur `realtime.messages` n'autorise l'écoute d'un topic qu'aux membres de l'organisation, ou au chauffeur concerné. Le dashboard garde un rafraîchissement de secours toutes les 6 s en cas de coupure du WebSocket.

## Notifications (outbox)

Les notifications sont insérées dans `notifications` **dans la même transaction** que l'événement métier (offre, attribution, annulation, rappel), puis `pg_notify('rydar_notifications')` réveille le worker. Le worker :

1. réserve un lot avec `private.claim_notifications`, en `SKIP LOCKED`. Les notifications d'offres déjà fermées ne partent jamais : elles sont annulées avec la raison `offer_closed` ;
2. envoie via Expo Push (par défaut), FCM HTTP v1 ou APNs HTTP/2, avec le canal Android `ride-offers` (priorité max, son) et la catégorie iOS `ride_offer` (actions ACCEPTER / REFUSER) ;
3. finalise avec `private.complete_notification` : succès, nouvel essai avec backoff exponentiel (2 tentatives au plus pour une offre, qui n'a de sens que 30 s ; 5 pour le reste) ou échec définitif. Les jetons refusés par le fournisseur sont désactivés (`private.deactivate_push_tokens`).

Côté app chauffeur, l'offre s'affiche aussi par Realtime quand l'app est ouverte : le push n'est qu'un canal parmi d'autres.

## Géolocalisation chauffeur

L'app envoie sa position avec `update_driver_location`. La fonction répond avec l'intervalle d'envoi conseillé : environ **5 s** en course, **15 s** en attente, **120 s** à l'arrêt prolongé. La tâche de fond `expo-location` adapte sa précision et sa fréquence en conséquence, pour économiser la batterie. La dernière position est *upsertée* dans `driver_locations` (colonne `geography` générée, index GiST). L'historique est échantillonné dans `driver_location_history`, puis purgé par le ménage.

## Rôles

| Rôle | Portée | Peut |
| --- | --- | --- |
| Super Admin (`users.is_super_admin`) | Plateforme | Créer, suspendre et archiver des organisations, gérer les offres et les limites, voir l'activité et les erreurs de dispatch de toutes les organisations |
| `owner` / `admin` | Une organisation | Tout gérer dans l'organisation : chauffeurs, réglages, clés API, équipe, abonnement |
| `dispatcher` | Une organisation | Créer, attribuer et annuler des courses, suivre la flotte |
| Chauffeur (`drivers.user_id`) | Ses offres et ses courses | Passer EN LIGNE / HORS LIGNE, envoyer sa position, accepter ou refuser, faire avancer **ses** courses |
