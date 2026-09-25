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
| Suivi & échanges | `ride_alerts` (alertes de suivi), `chat_messages` (fils direct / flotte, signalements géolocalisés), `chat_reads` (accusés de lecture), `chat_report_votes` |
| Centrale à commission | `ride_settlements` (règlement de chaque course terminée), `banned_identities` (identités bannies, hachées), `fraud_reports` (signalements au super admin) |

Les paramètres de dispatch sont réglables par organisation (`organization_settings`) :

| Paramètre | Défaut | Effet |
| --- | --- | --- |
| `dispatch_radii_m` | `{4000, 8000, 12000, 16000}` | Rayons successifs des vagues GPS |
| `offer_timeout_seconds` | 30 | Durée de vie d'une offre instantanée |
| `max_search_seconds` | 300 | Au-delà : `NO_DRIVER_FOUND` |
| `max_offers_per_wave` | 25 | Chauffeurs notifiés au plus par vague |
| `instant_threshold_minutes` | 45 | Prise en charge ≤ maintenant + 45 min : course **instantanée**, sinon **planifiée** |
| `scheduled_dispatch_lead_minutes` | 60 | Planifiée encore libre à T-60 min : bascule en recherche GPS |
| `reminder_offsets_minutes` | `{1440, 180, 60, 30}` | Rappels au chauffeur attribué |
| `allow_category_upgrade` | true | Un véhicule de catégorie supérieure peut prendre une course inférieure |
| `location_max_age_seconds` | 180 | Position plus ancienne : chauffeur ignoré |
| `flight_tracking_enabled` | true | Suivi des vols des courses au départ d'un aéroport |
| `flight_pickup_buffer_minutes` | 15 | Marge après l'atterrissage, utilisée seulement sans horaire prévu ou si l'heure demandée précède l'arrivée |
| `late_alert_tolerance_minutes` | 5 | Retard toléré avant alerte « chauffeur en retard » |
| `stalled_alert_minutes` | 4 | Immobilité (en route, loin du départ) avant alerte |
| `driver_commission_percent` | — | Commission de la centrale : net estimé dans les gains du chauffeur ; en mode centrale, part automatique de chaque course |
| `driver_commission_fixed_cents` | — | Mode centrale : commission fixe ajoutée au pourcentage |
| `settlement_grace_hours` | 24 | Mode centrale : délai pour régler une commission (0 = tout de suite) |
| `block_unpaid` | true | Mode centrale : commission en retard ou contestée → plus d'offres |
| `settlement_credit_limit_cents` | — | Mode centrale : encours maximal à régler avant blocage |
| `new_driver_max_price_cents` | — | Mode centrale : prix maximal des courses proposées à un chauffeur « Nouveau » |
| `trust_after_rides` | 10 | Mode centrale : passage automatique « Confirmé » après N courses réglées |
| `settlement_methods`, `settlement_link`, `settlement_instructions` | lien, espèces | Mode centrale : moyens de paiement acceptés, lien prérempli (`{montant}`, `{montant_centimes}`, `{reference}`), consignes |

## Moteur de dispatch

### 1. Création

Qu'elle vienne de l'API, du dashboard ou du mini-site, une course passe par le trigger `before_ride_insert`. Il vérifie l'organisation, qui doit être active et à laquelle l'appelant doit appartenir. Il force la source et le créateur, puis attribue un numéro séquentiel par organisation (`#1928`). Enfin, il classe la course : **instantanée** si la prise en charge a lieu dans le seuil, **planifiée** sinon. Les limites de l'offre (courses par mois) sont vérifiées au même moment.

`after_ride_insert` appelle ensuite `private.start_dispatch`, dans la même transaction.

### 2. Course instantanée : vagues GPS

`private.run_geo_wave` sélectionne les chauffeurs qui remplissent **toutes** ces conditions :

- ils appartiennent à la **même organisation** ;
- ils sont `active` et `available` ;
- leur position a moins de `location_max_age_seconds` et une précision meilleure que 1,5 km ;
- leur véhicule est de catégorie compatible et a assez de places ;
- ils n'ont pas déjà décliné cette course ;
- ils se trouvent à moins de R mètres : `ST_DWithin(driver_locations.location, rides.pickup_location, R)`.

Ils sont triés par distance, dans la limite de `max_offers_per_wave`. S'il n'y a personne dans 4 km, la vague suivante (8 km, puis 12, puis 16) est lancée **immédiatement**, dans la même transaction.

Pour les chauffeurs retenus, le moteur crée dans une seule transaction :

- une ligne `ride_offers` (`pending`, expiration à +30 s) ;
- une notification dans l'outbox ;
- le passage du chauffeur à `offered`.

La course passe à `OFFERED`. La timeline enregistre par exemple : « Recherche GPS — rayon 4 km (vague 1) », « 12 chauffeurs en ligne », « 5 chauffeurs à moins de 4 km », « 5 notifications envoyées ».

Toutes les 2 s, le worker appelle `private.dispatch_tick()`. Cette fonction verrouille les courses dues avec `FOR UPDATE SKIP LOCKED`, ce qui permet de lancer plusieurs workers. Quand une vague reste sans réponse après `offer_timeout_seconds`, le rayon s'élargit et les vagues sont **cumulatives** : les chauffeurs déjà sollicités **gardent leur offre** (prolongée, sans nouvelle sonnerie) et la vague ajoute ceux du rayon suivant. À 8 km, ce sont donc bien tous les chauffeurs à moins de 8 km qui peuvent accepter. Après la dernière vague, seuls les chauffeurs nouvellement disponibles dans la zone sont notifiés. Si la recherche dépasse `max_search_seconds`, les offres sont fermées et la course passe à `NO_DRIVER_FOUND`. « Relancer » et la bascule d'une planifiée repartent de 4 km.

### 3. Course planifiée : offre à la flotte

`private.offer_to_fleet` propose la course à toute la flotte éligible de l'organisation (actifs, en ligne ou non, catégorie compatible, places suffisantes), sans critère de distance. L'offre reste ouverte jusqu'à T-`scheduled_dispatch_lead_minutes`, et la flotte est re-balayée toutes les 5 min : un chauffeur ajouté ou réactivé entre-temps la reçoit aussi. Si personne ne l'a prise à T-lead, le tick **bascule en recherche GPS** (4 km d'abord). Quand un chauffeur est attribué, les rappels (24 h, 3 h, 1 h, 30 min) sont programmés dans l'outbox avec `scheduled_for`.

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

### 6. Suivi des vols

La colonne générée `rides.flight_mode` vaut `arrival` quand le départ de la course est un aéroport (le client arrive par ce vol) et `departure` sinon (information seulement). Toutes les minutes, le worker réserve les courses à vérifier avec `private.flights_to_check` (`SKIP LOCKED`, toutes les 5 min à moins de 3 h de la prise en charge, sinon toutes les 30 min). Il interroge le fournisseur, puis appelle `private.apply_flight_status`. Le décalage est **relatif au retard** : nouvelle prise en charge = heure demandée + (arrivée estimée − arrivée prévue). Il n'est appliqué qu'au-delà de 5 min d'écart, jamais dans le passé, et plafonné à 12 h. L'heure demandée est conservée dans `pickup_at_original`. Une course planifiée proposée à la flotte voit sa bascule GPS et ses offres recalées ; au chauffeur attribué, on recalcule les rappels et on envoie une notification `flight_update`. Une simple vérification sans changement ne modifie rien, donc ne déclenche aucune diffusion.

### 7. Alertes de suivi (la centrale décide)

Toutes les 30 s, `private.watch_rides()` (verrou consultatif, un seul worker à la fois) examine les courses attribuées :

- **late** : arrivée estimée au départ au-delà de l'heure promise + tolérance. La référence d'une course instantanée est l'heure promise à l'acceptation.
- **stalled** : chauffeur en route qui ne bouge plus, loin du départ.
- **no_gps** : aucune position depuis plus de 3 min.
- **not_started** : planifiée imminente, chauffeur hors ligne ou sans position.

Une alerte reste unique par course et par type (index partiel), se met à jour et se ferme seule quand le problème disparaît. Aucune action automatique n'est prise. La centrale choisit :

| Action | RPC | Effet |
| --- | --- | --- |
| Garder | `acknowledge_ride_alert` | Sourdine 15 min |
| Réattribuer | `assign_ride` | Attribue à un chauffeur choisi, y compris depuis « en route » |
| Relancer | `reassign_ride(ride, motif, chauffeur attendu)` | Retire la course et relance la recherche à 4 km, ou à la flotte si elle est planifiée |

Pour « Relancer » : `DRIVER_CHANGED` est renvoyé si la course a changé de chauffeur entre-temps. Si le dispatch automatique est désactivé, la course passe simplement en attente d'attribution manuelle. Le chauffeur retiré est marqué par une offre `closed / removed_by_dispatch` : il n'est plus sollicité pour cette course, sans que cela compte comme un refus.

### 8. Messagerie et signalements

`chat_messages` porte deux types de fils : `driver` (centrale ⇄ un chauffeur) et `fleet` (toute l'organisation). Un signalement (`report_type` police, control, accident, traffic, danger) est un message de flotte avec position obligatoire et expiration. Chaque vote « toujours là » le prolonge d'au moins 30 min. Deux votes « plus là » l'expirent, de même qu'un seul vote de son auteur ou de la centrale. Chaque votant n'a qu'un vote, qu'il peut changer. Les envois passent par `send_chat_message`, avec une limite de débit en base (`PT429`). Un signalement notifie les chauffeurs en ligne à moins de 25 km (`fleet_report`) ; un message direct de la centrale notifie le chauffeur (`chat_message`). Les accusés de lecture sont stockés dans `chat_reads`.

### 9. Gains et documents

`driver_earnings(p_days)` agrège les courses terminées du chauffeur : jour, semaine du lundi et mois dans le fuseau de l'organisation, série sur 7 jours, net estimé si une commission est réglée. Le chauffeur dépose ses documents avec `driver_submit_document` ; ils restent « en attente » jusqu'à `review_driver_document` par la centrale. `private.document_reminders()` (worker, toutes les 6 h) passe les documents échus en « expiré » et envoie des rappels à J-30, J-7 et J-0, sans doublon.

### 10. Mode « Centrale à commission » (option 2)

Le super admin choisit pour chaque compte un modèle d'exploitation (`organizations.dispatch_model`, sans aucun droit côté client) : **flotte** (option 1, tout ce qui précède) ou **centrale** (option 2 : réseau de chauffeurs indépendants, typiquement issus de groupes WhatsApp / Telegram). Le moteur de dispatch est le même ; le mode centrale ajoute :

- **Répartition** (`rides.commission_cents`, `platform_fee_cents`, `driver_payout_cents`) calculée par le trigger `rides_centrale_split` : frais plateforme (% + fixe, super admin), commission de la centrale (% + fixe des réglages, ou saisie à la course), part chauffeur = le reste. Exemple : 59 € = 40 € chauffeur + 14 € commission + 5 € plateforme. `COMMISSION_TOO_HIGH` si la saisie dépasse ; prix obligatoire depuis le tableau de bord (`PRICE_REQUIRED`), toléré par l'API et le mini-site (répartition calculée dès que le prix est fixé). La notification d'offre et `driver_offers()` affichent « Vous gagnez 40 € ».
- **Règlements** (`ride_settlements`, une ligne par course terminée, trigger `rides_d_settlement`) : si le client a payé le chauffeur (espèces, carte à bord), le chauffeur doit commission + frais (`driver_owes`) ; si le client a payé la centrale (en ligne, facture, compte), la centrale doit la part chauffeur (`centrale_owes`). Statuts `due` → `declared` (« J'ai payé », `driver_declare_payment`) → `paid` (« Reçu », `confirm_settlements`) ; `disputed` (« Pas reçu », `dispute_settlement`), `waived` (`waive_settlement`), réouverture (`reopen_settlement`). Référence `C{numéro}` et lien de paiement prérempli. Prix et commission sont verrouillés dès que le règlement n'est plus « à régler » (`SETTLEMENT_LOCKED`). Relances : manuelle (`remind_driver_settlements`, une toutes les 30 min) et automatique (`private.settlement_reminders()`, worker, une par chauffeur toutes les 24 h, 3 au plus).
- **Blocages** (`private.centrale_blocker`) appliqués aux vagues GPS, à l'offre à la flotte et à l'acceptation (`DRIVER_BLOCKED`) : commission en retard ou contestée (`unpaid`), encours au-delà du plafond (`credit_limit`), chauffeur « Nouveau » au-dessus du prix plafond (`new_driver`). Un paiement déclaré débloque tout de suite ; la centrale peut le contester. Passage automatique « Confirmé » après `trust_after_rides` courses réglées sans impayé.
- **Bannissement définitif** (`ban_driver`, owner / admin) : compte suspendu, courses non commencées remises en recherche, offres fermées, et identités **hachées** (sha256 de la valeur normalisée : téléphone, e-mail avec variantes Gmail, carte VTC, permis, pièce d'identité, identifiant d'appareil, plaque en option) enregistrées dans `banned_identities`. Des triggers refusent ensuite ces identités à toute création ou inscription (`IDENTITY_BANNED`) et interdisent la réactivation (`DRIVER_BANNED`) ; un appareil déjà utilisé par un banni suspend le nouveau compte et alerte la centrale (`driver.flagged`). Le bannissement vaut pour la centrale ; un signalement (`fraud_reports`) permet au super admin de bannir de **toute la plateforme** (`svc_platform_ban`, y compris les comptes existants dans d'autres centrales) ou de lever (`svc_platform_unban`).
- **Inscription par lien** (`/rejoindre/{code}`, `set_join_link`) : la route serveur vérifie l'identité (`svc_identity_check`), crée le compte Auth puis la candidature (`svc_driver_apply` : chauffeur « inactif », `application_status = 'pending'`, niveau « Nouveau »). La centrale valide (`approve_driver_application`, limites de l'offre vérifiées) ou refuse ; validation automatique possible. Le candidat se connecte à l'app avant validation (`driver_account_state()`) et peut déjà déposer ses documents.

## Temps réel

Des triggers publient les changements avec `realtime.send` (Supabase Realtime, canaux **privés**) :

| Topic | Événements | Abonnés |
| --- | --- | --- |
| `org:{organization_id}` | `driver.location`, `driver.updated`, `ride.updated`, `ride.event`, `offer.updated`, `ride.alert`, `chat.message`, `chat.report`, `chat.read`, `driver.document`, `settlement.updated`, `driver.application`, `driver.flagged` | Dashboard (carte, listes, timeline, alertes, messagerie, encaissements, candidatures) |
| `driver:{driver_id}` | `offer.updated`, `ride.updated`, `ride.unassigned`, `chat.message`, `chat.read`, `driver.document`, `settlement.updated` | App chauffeur |
| `fleet:{organization_id}` | `chat.message` (fil flotte), `chat.report` | Chauffeurs et membres de l'organisation |

La policy RLS sur `realtime.messages` n'autorise l'écoute d'un topic qu'aux membres de l'organisation, ou au chauffeur concerné. `fleet:{org}` est ouvert aux chauffeurs de l'organisation, mais **jamais** `org:{org}` : ce topic transporte les données clients. Le dashboard garde un rafraîchissement de secours toutes les 6 s en cas de coupure du WebSocket.

## Notifications (outbox)

Les notifications sont insérées dans `notifications` **dans la même transaction** que l'événement métier (offre, attribution, annulation, rappel), puis `pg_notify('rydar_notifications')` réveille le worker. Le worker :

1. réserve un lot avec `private.claim_notifications`, en `SKIP LOCKED`. Les notifications d'offres déjà fermées ne partent jamais : elles sont annulées avec la raison `offer_closed` ;
2. envoie via Expo Push (par défaut), FCM HTTP v1 ou APNs HTTP/2, avec le canal Android `ride-offers-v2` (priorité max, sonnerie de 10 s) et la catégorie iOS `ride_offer` (actions ACCEPTER / REFUSER) ;
3. finalise avec `private.complete_notification` : succès, nouvel essai avec backoff exponentiel (2 tentatives au plus pour une offre, qui n'a de sens que 30 s ; 5 pour le reste) ou échec définitif. Les jetons refusés par le fournisseur sont désactivés (`private.deactivate_push_tokens`).

Côté app chauffeur, l'offre s'affiche aussi par Realtime quand l'app est ouverte : le push n'est qu'un canal parmi d'autres.

## Géolocalisation chauffeur

L'app envoie sa position avec `update_driver_location`. La fonction répond avec l'intervalle d'envoi conseillé : environ **5 s** en course, **15 s** en attente, **120 s** à l'arrêt prolongé. La tâche de fond `expo-location` adapte sa précision et sa fréquence en conséquence, pour économiser la batterie. La dernière position est *upsertée* dans `driver_locations` (colonne `geography` générée, index GiST). L'historique est échantillonné dans `driver_location_history`, puis purgé par le ménage.

## Rôles

| Rôle | Portée | Peut |
| --- | --- | --- |
| Super Admin (`users.is_super_admin`) | Plateforme | Créer, suspendre et archiver des organisations, choisir leur modèle (flotte / centrale) et les frais plateforme, donner les accès, gérer les offres et les limites, voir l'activité de toutes les organisations, bannir de toute la plateforme |
| `owner` / `admin` | Une organisation | Tout gérer dans l'organisation : chauffeurs, réglages, clés API, équipe, abonnement ; en mode centrale : lien d'inscription, candidatures, bannissements, annulation de dettes |
| `dispatcher` | Une organisation | Créer, attribuer et annuler des courses, suivre la flotte ; en mode centrale : confirmer ou contester les paiements, relancer |
| Chauffeur (`drivers.user_id`) | Ses offres et ses courses | Passer EN LIGNE / HORS LIGNE, envoyer sa position, accepter ou refuser, faire avancer **ses** courses |
