# Architecture

Rydar Drive repose sur un principe : **la base de données est l'arbitre**. Isolation des organisations, éligibilité des chauffeurs, attribution d'une course et transitions de statut sont codées en SQL (RLS et PL/pgSQL). Les applications (web, worker, app chauffeur) appellent ces fonctions. Elles ne peuvent ni les contourner ni se contredire.

## Composants

| Composant | Rôle | Technologies |
| --- | --- | --- |
| **PostgreSQL / Supabase** | Données, RLS, moteur de dispatch, temps réel, outbox des notifications | PostgreSQL 16, PostGIS 3, Supabase Auth, Realtime (broadcast), Storage |
| **apps/web** | Dashboard rattacheur, Super Admin, API publique v1, mini-site de réservation, facturation | Next.js 16 (App Router, `proxy.ts`), React 19, Tailwind v4, Radix, MapLibre GL, Recharts, @supabase/ssr, Stripe |
| **apps/worker** | Tick du dispatch (expirations, vagues suivantes, escalades), envoi des pushs et des relances WhatsApp, webhooks sortants des centrales (garde SSRF, signature, nouveaux essais), ménage (durées de conservation), reprise des suppressions de compte chauffeur | Node 22, `pg` (LISTEN/NOTIFY, `FOR UPDATE SKIP LOCKED`), Expo Push, FCM HTTP v1, APNs HTTP/2, API WhatsApp Cloud, API Storage et Auth de Supabase (clé service role) |
| **mailer** (même image, `dist/mailer.js`) | E-mails du formulaire de contact : lit la file `email_outbox` (`private.claim_emails`, réveil `LISTEN rydar_emails`) et l'envoie au serveur mail du VPS (SMTP `127.0.0.1:25`, réseau de l'hôte), réessais espacés puis échec visible dans `/admin/contacts` | Node 22, `pg`, nodemailer |
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
| Intégrations | `api_keys` (métadonnées), `api_key_secrets` (hash HMAC, service role uniquement), `api_logs`, `notifications` (outbox), `webhook_endpoints` (adresses), `webhook_endpoint_secrets` (secrets de signature, service role seul), `webhook_deliveries` (file des envois, sans charge utile) |
| Suivi & échanges | `ride_alerts` (alertes de suivi), `chat_messages` (fils direct / flotte, signalements géolocalisés), `chat_reads` (accusés de lecture), `chat_report_votes` |
| Modération | `chat_message_reports` (messages du fil flotte signalés), `chat_blocks` (auteurs masqués par un chauffeur) |
| Centrale à commission | `ride_settlements` (règlement de chaque course terminée), `banned_identities` (identités bannies, hachées), `fraud_reports` (signalements au super admin) |
| Frais plateforme | `platform_billing` (coordonnées de paiement de Rydar), `platform_fee_entries` (registre immuable), `platform_payments` |
| WhatsApp | `org_whatsapp`, `platform_whatsapp` (configuration), `org_whatsapp_secrets`, `platform_whatsapp_secrets` (jetons, service role seul) |
| Légal | `platform_legal` (éditeur, hébergeurs), `legal_acceptances` (preuves d'acceptation, ajout seul) |
| Suppressions | `private.account_deletions` (file : dossier des justificatifs et compte de connexion à supprimer) |

Les paramètres de dispatch sont réglables par organisation (`organization_settings`) :

| Paramètre | Défaut | Effet |
| --- | --- | --- |
| `dispatch_radii_m` | `{4000, 8000, 12000, 16000}` | Rayons successifs des vagues GPS (une vague par délai) |
| `dispatch_retry_radii_m` | `{4000, 8000}` | Relance quand personne n'a accepté après le dernier rayon (`{}` : pas de relance) |
| `offer_timeout_seconds` | 30 | Durée d'une vague (et d'une offre instantanée) |
| `max_search_seconds` | 300 | N'est plus utilisé par le dispatch GPS (la séquence de vagues fixe la fin) |
| `location_max_age_seconds` | 180 | Position en direct : au-delà (2 min au moins), le chauffeur n'est pas sollicité |
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
| `settlement_methods`, `settlement_link`, `settlement_instructions`, `settlement_payee_name`, `settlement_iban`, `settlement_bic` | lien, espèces | Mode centrale : moyens de paiement acceptés (lien, virement avec RIB, espèces, autre), lien prérempli (`{montant}`, `{montant_centimes}`, `{reference}`), consignes. Un moyen n'est proposé au chauffeur que s'il est renseigné (`private.settlement_methods_available`) ; sinon, espèces |

## Moteur de dispatch

### 1. Création

Qu'elle vienne de l'API, du dashboard ou du mini-site, une course passe par le trigger `before_ride_insert`. Il vérifie l'organisation, qui doit être active et à laquelle l'appelant doit appartenir. Il force la source et le créateur, puis attribue un numéro séquentiel par organisation (`#1928`). Enfin, il classe la course : **instantanée** si la prise en charge a lieu dans le seuil, **planifiée** sinon. Les limites de l'offre (courses par mois) sont vérifiées au même moment.

`after_ride_insert` appelle ensuite `private.start_dispatch`, dans la même transaction.

### 2. Course instantanée : vagues GPS

`private.run_geo_wave` sélectionne les chauffeurs qui remplissent **toutes** ces conditions :

- ils appartiennent à la **même organisation** ;
- ils sont `active` et `available` ;
- leur position est EN DIRECT (moins de `location_max_age_seconds`, `private.dispatch_location_window`) et précise à 1,5 km près. L'app l'envoie en continu, téléphone verrouillé ou dans une autre application ; l'offre part par push et sonne ;
- leur véhicule est de catégorie compatible et a assez de places ;
- ils n'ont pas déjà décliné cette course ;
- ils se trouvent à moins de R mètres : `ST_DWithin(driver_locations.location, rides.pickup_location, R)`.

Ils sont triés par distance, dans la limite de `max_offers_per_wave`. **Une vague par délai** : même sans personne dans 4 km, la vague dure `offer_timeout_seconds` avant de passer à 8 km (migration 003200).

Pour les chauffeurs retenus, le moteur crée dans une seule transaction :

- une ligne `ride_offers` (`pending`, expiration à +30 s) ;
- une notification dans l'outbox ;
- le passage du chauffeur à `offered`.

La course passe à `OFFERED`. La timeline enregistre par exemple : « Recherche GPS — rayon 4 km (vague 1) », « 12 chauffeurs en ligne », « 5 chauffeurs à moins de 4 km », « 5 notifications envoyées ».

Toutes les 2 s, le worker appelle `private.dispatch_tick()`. Cette fonction verrouille les courses dues avec `FOR UPDATE SKIP LOCKED`, ce qui permet de lancer plusieurs workers. Quand personne n'a accepté pendant `offer_timeout_seconds` (ou que tous ont refusé), le rayon s'élargit et les vagues sont **cumulatives** : les chauffeurs déjà sollicités **gardent leur offre** une vague de plus (prolongée, sans nouvelle sonnerie), puis elle est fermée « ignorée » ; la vague ajoute ceux du rayon suivant.

Séquence par défaut : **4 → 8 → 12 → 16 km**, puis **relance 4 → 8 km** (`dispatch_retry_radii_m`) où les chauffeurs restés sans réponse sont re-sonnés (« COURSE TOUJOURS DISPONIBLE ») ; un refus ou un retrait par la centrale n'est jamais re-sonné. Après la dernière vague, les offres sont fermées, la course passe à `NO_DRIVER_FOUND` et le dispatch est alerté (`dispatch.no_driver`, son + notification navigateur), avec l'explication des chauffeurs en ligne qui n'ont pas pris la course. « Relancer » et la bascule d'une planifiée repartent de 4 km.

Position en direct (migrations 003200 → 003400) — règle : **app ouverte = en ligne et position en direct, app fermée = hors ligne** :

- **App ouverte** (premier plan, arrière-plan, téléphone verrouillé, autre application) : tâche GPS de fond (`apps/driver/src/lib/location.ts`, `startLocationUpdatesAsync` : précision maximale, aucun filtre de distance, jamais de pause, pas de regroupement), service de premier plan Android « EN LIGNE » (un point toutes les 5 s), au moins une position fraîche par minute même immobile (battement porté par le flux GPS, minuterie en plus sur iPhone), jamais de position de plus de 2 min ; sans point GPS (sous-sol), signe de vie `driver_heartbeat()`. Android : si l'économie de batterie restreint l'app, une alerte propose au passage en ligne d'ouvrir ses réglages (Batterie › Non restreinte), sans permission d'exemption (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` bloquée).
- **App fermée** (balayée, arrêtée par le système) : service Android arrêté avec l'app (`killServiceOnDestroy`), une relance sans interface ne reprend pas le suivi ; ni position ni signe de vie depuis 3 min (15 min pour les versions de l'app antérieures à 1.1.0, sans battement) → **hors ligne en silence** (`private.watch_driver_gps`, worker 30 s), offres en attente closes. Aucune notification. Un chauffeur en course n'est jamais touché.
- Le ménage (`private.housekeeping`) ne met jamais un chauffeur hors ligne.

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

**Modération du fil flotte** (migration 004100) : la centrale en est responsable. Un chauffeur signale un message (`report_chat_message`, motif facultatif ; le message disparaît aussitôt de son fil) ou masque un auteur (`block_chat_author` : ses messages et ses alertes de signalement ne lui parviennent plus, l'auteur n'en sait rien). La centrale reçoit `chat.moderation` (alerte et badge dans Messages), puis supprime le message pour tous (`remove_chat_message` : `deleted_at`, signalements « removed », alertes en file annulées, texte retiré du journal) ou classe le signalement (`dismiss_chat_report`). Avant la première publication dans le fil, l'app fait accepter les règles (CGU § 8, `LEGAL_VERSION`), sur l'écran d'acceptation des conditions ou, à défaut, dans une feuille « Règles du fil » ; `driver_chat_overview` renvoie la dernière version acceptée (`rules_version`). Un compte chauffeur supprimé perd ses masquages et les signalements qu'il a rédigés (déclencheur `drivers_chat_forget_deleted`).

### 9. Gains et documents

`driver_earnings(p_days)` agrège les courses terminées du chauffeur : jour, semaine du lundi et mois dans le fuseau de l'organisation, série sur 7 jours, net estimé si une commission est réglée. Le chauffeur dépose ses documents avec `driver_submit_document` ; ils restent « en attente » jusqu'à `review_driver_document` par la centrale. `private.document_reminders()` (worker, toutes les 6 h) passe les documents échus en « expiré » et envoie des rappels à J-30, J-7 et J-0, sans doublon.

### 10. Mode « Centrale à commission » (option 2)

Le super admin choisit pour chaque compte un modèle d'exploitation (`organizations.dispatch_model`, sans aucun droit côté client) : **flotte** (option 1, tout ce qui précède) ou **centrale** (option 2 : réseau de chauffeurs indépendants, typiquement issus de groupes WhatsApp / Telegram). Le moteur de dispatch est le même ; le mode centrale ajoute :

- **Répartition** (`rides.commission_cents`, `platform_fee_cents`, `driver_payout_cents`) calculée par le trigger `rides_centrale_split` : frais plateforme (% + fixe, super admin), commission de la centrale (% + fixe des réglages, ou saisie à la course), part chauffeur = le reste. Exemple : 59 € = 40 € chauffeur + 14 € commission + 5 € plateforme. `COMMISSION_TOO_HIGH` si la saisie dépasse ; prix obligatoire depuis le tableau de bord (`PRICE_REQUIRED`), toléré par l'API et le mini-site (répartition calculée dès que le prix est fixé). La notification d'offre et `driver_offers()` affichent « Vous gagnez 40 € ».
- **Règlements** (`ride_settlements`, une ligne par course terminée, trigger `rides_d_settlement`) : si le client a payé le chauffeur (espèces, carte à bord), le chauffeur doit commission + frais (`driver_owes`) ; si le client a payé la centrale (en ligne, facture, compte), la centrale doit la part chauffeur (`centrale_owes`). Statuts `due` → `declared` (« J'ai payé », `driver_declare_payment`) → `paid` (« Reçu », `confirm_settlements`) ; `disputed` (« Pas reçu », `dispute_settlement`), `waived` (`waive_settlement`), réouverture (`reopen_settlement`). Référence `C{numéro}` et lien de paiement prérempli. Prix et commission sont verrouillés dès que le règlement n'est plus « à régler » (`SETTLEMENT_LOCKED`). Relances : manuelle (`remind_driver_settlements`, une toutes les 30 min) et automatique (`private.settlement_reminders()`, worker, une par chauffeur toutes les 24 h, 3 au plus).
- **Blocages** (`private.centrale_blocker`) appliqués aux vagues GPS, à l'offre à la flotte et à l'acceptation (`DRIVER_BLOCKED`) : commission en retard ou contestée (`unpaid`), encours au-delà du plafond (`credit_limit`), chauffeur « Nouveau » au-dessus du prix plafond (`new_driver`). Un paiement déclaré débloque tout de suite ; la centrale peut le contester. Passage automatique « Confirmé » après `trust_after_rides` courses réglées sans impayé.
- **Bannissement définitif** (`ban_driver`, owner / admin) : compte suspendu, courses non commencées remises en recherche, offres fermées, et identités **hachées** (sha256 de la valeur normalisée : téléphone, e-mail avec variantes Gmail, carte VTC, permis, pièce d'identité, identifiant d'appareil, plaque en option) enregistrées dans `banned_identities`. Des triggers refusent ensuite ces identités à toute création ou inscription (`IDENTITY_BANNED`) et interdisent la réactivation (`DRIVER_BANNED`) ; un appareil déjà utilisé par un banni suspend le nouveau compte et alerte la centrale (`driver.flagged`), de même que les autres fiches de la centrale déjà enregistrées sur cet appareil au moment du bannissement (vérification requise). Le bannissement vaut pour la centrale ; un signalement (`fraud_reports`) permet au super admin de bannir de **toute la plateforme** (`svc_platform_ban`, migration 004600) ou de lever (`svc_platform_unban`). Avant de décider, il voit les fiches qui partagent une identité du signalement (`admin_fraud_report_matches`, avec la date de la dernière saisie de chaque identité par la centrale qui signale) : le chauffeur signalé et les fiches de sa centrale sont bannis de la plateforme, mais une fiche d'une **autre** centrale ne l'est que si le super admin la coche ; une identité portée par une fiche non cochée n'est pas bannie de la plateforme (elle reste refusée dans la centrale qui signale). Au niveau plateforme, le compte de connexion (Auth) des fiches bannies est verrouillé, sauf s'il sert aussi à gérer une centrale ou la plateforme. La levée rend à chaque centrale le bannissement qu'elle avait elle-même posé (compte toujours verrouillé) ; les autres fiches sont débannies, compte déverrouillé, mais restent suspendues jusqu'à la décision de leur centrale.
- **Inscription par lien** (`/rejoindre/{code}`, `set_join_link`) : la route serveur vérifie l'identité (`svc_identity_check`), crée le compte Auth puis la candidature (`svc_driver_apply` : chauffeur « inactif », `application_status = 'pending'`, niveau « Nouveau »). La centrale valide (`approve_driver_application`, limites de l'offre vérifiées) ou refuse ; validation automatique possible. Le candidat se connecte à l'app avant validation (`driver_account_state()`) et peut déjà déposer ses documents. **Aussi pour les flottes** (migration 006300) : même parcours et mêmes contrôles (identités bannies, empreintes d'un débiteur, limite de chauffeurs, compte déjà rattaché), menu « Inscriptions » au lieu de « Réseau » (même page `/dashboard/network`), textes sans commission ni « centrale » (`svc_join_info.dispatch_model`, `components/network/join-copy.ts` ; réponse sans modèle → centrale, `joinInfoModel`), candidat validé par un owner / admin « Confirmé » comme un chauffeur créé par la flotte ; entré par la validation automatique, il reste « Nouveau » (sans effet en flotte, plafonné si le compte passe en centrale : personne ne l'a vérifié). Un changement de modèle par le super admin ne coupe plus le lien : code, état, validation automatique et candidatures en attente sont conservés.
- **Moyens de paiement** (migration 003800) : la centrale renseigne un lien de paiement, un RIB (bénéficiaire, IBAN, BIC), des consignes pour « autre » (Wero, Lydia, au bureau…) et coche les moyens acceptés ; le chauffeur ne se voit proposer que les moyens cochés **et** renseignés, puis déclare « J'ai payé » avec le moyen utilisé.

### 11. Suppression du compte chauffeur (migrations 003500, 004000)

Depuis l'app (`POST /api/driver/delete-account`) ou, pour une demande reçue par e-mail, depuis `/admin/suppressions` (super admin) : `private.delete_driver_account` refuse si une course est attribuée, puis, dans une seule transaction, efface les données personnelles (justificatifs, positions, appareils, jetons, notifications, messages, signalements, votes), retire le nom partout où il était recopié (journal des courses, alertes, règlements, signalement de fraude, journal d'audit caviardé avec l'IP et le navigateur du chauffeur), anonymise la fiche (« Chauffeur supprimé (#N) », détachée du compte, puis figée par le garde-fou `DRIVER_DELETED` : ni réactivation, ni bannissement, ni changement de niveau de confiance, ni nouveau justificatif) et met en file (`private.account_deletions`) la purge du dossier `{centrale}/{chauffeur}/` des justificatifs et la suppression du compte de connexion. La route (ou l'outil) traite aussitôt la file avec la clé service role ; en cas d'échec, le worker la reprend toutes les 5 min (nouvel essai espacé jusqu'à 6 h, abandon au 10ᵉ essai avec audit critique, « Réessayer » sur `/admin/suppressions`). Le compte d'un membre de centrale ou d'un super admin est conservé : seul le profil chauffeur disparaît. Bannissement : empreintes gardées (indices en clair effacés), puis effacées 3 ans après le bannissement (`private.purge_expired_bans`, filet `private.purge_deleted_driver_bans`).

### 12. Documents légaux (migration 003900)

`platform_legal` porte l'identité de l'éditeur (pages publiques, `public_legal_info()`, saisie dans `/admin/legal`). `legal_acceptances` garde les preuves en ajout seul : CGU et politique de confidentialité acceptées par chaque chauffeur (inscription par lien, écran de l'app) et chaque membre (bandeau du tableau de bord) ; CGV et accord de traitement au nom de la centrale (owner / admin). La version en vigueur est `LEGAL_VERSION` (`@rydar/shared`), commune au site et à l'app. Les durées de conservation annoncées sont appliquées par `private.housekeeping` (docs/DEPLOYMENT.md § 6).

## Temps réel

Des triggers publient les changements avec `realtime.send` (Supabase Realtime, canaux **privés**) :

| Topic | Événements | Abonnés |
| --- | --- | --- |
| `org:{organization_id}` | `driver.location`, `driver.updated`, `ride.updated`, `ride.event`, `offer.updated`, `ride.alert`, `chat.message`, `chat.report`, `chat.read`, `chat.moderation`, `driver.document`, `settlement.updated`, `driver.application`, `driver.flagged`, `platform.updated` | Dashboard (carte, listes, timeline, alertes, messagerie et modération, encaissements, candidatures, frais plateforme) |
| `driver:{driver_id}` | `offer.updated`, `ride.updated`, `ride.unassigned`, `chat.message`, `chat.read`, `driver.document`, `settlement.updated` | App chauffeur |
| `fleet:{organization_id}` | `chat.message` (fil flotte), `chat.report`, `chat.removed` (message retiré par la centrale) | Chauffeurs et membres de l'organisation |

La policy RLS sur `realtime.messages` n'autorise l'écoute d'un topic qu'aux membres de l'organisation, ou au chauffeur concerné. `fleet:{org}` est ouvert aux chauffeurs de l'organisation, mais **jamais** `org:{org}` : ce topic transporte les données clients. Le dashboard garde un rafraîchissement de secours toutes les 6 s en cas de coupure du WebSocket.

## Notifications (outbox)

Les notifications sont insérées dans `notifications` **dans la même transaction** que l'événement métier (offre, attribution, annulation, rappel), puis `pg_notify('rydar_notifications')` réveille le worker. Le worker :

1. réserve un lot avec `private.claim_notifications`, en `SKIP LOCKED`. Les notifications d'offres déjà fermées ne partent jamais : elles sont annulées avec la raison `offer_closed` ;
2. envoie via Expo Push (par défaut), FCM HTTP v1 ou APNs HTTP/2, avec le canal Android `ride-offers-v2` (priorité max, sonnerie de 10 s) et la catégorie iOS `ride_offer` (actions ACCEPTER / REFUSER) ;
3. finalise avec `private.complete_notification` : succès, nouvel essai avec backoff exponentiel (2 tentatives au plus pour une offre, qui n'a de sens que 30 s ; 5 pour le reste) ou échec définitif. Les jetons refusés par le fournisseur sont désactivés (`private.deactivate_push_tokens`).

Côté app chauffeur, l'offre s'affiche aussi par Realtime quand l'app est ouverte : le push n'est qu'un canal parmi d'autres.

Les relances WhatsApp passent par la même file (canal `whatsapp`) : `private.claim_whatsapp` réserve un lot avec les identifiants de l'expéditeur (jetons lus dans les tables `*_whatsapp_secrets`, service role seul), le worker envoie un modèle approuvé par l'API WhatsApp Cloud de Meta et `private.complete_whatsapp` termine l'envoi ; un échec définitif repasse par l'application ([WHATSAPP.md](WHATSAPP.md)).

## Webhooks sortants (migrations 006000, 006100)

Chaque centrale (offre avec l'API) peut enregistrer jusqu'à 10 adresses https qui reçoivent les changements de statut de
ses courses ; contrat public dans [API.md](API.md#webhooks).

1. **Détection en base** : les triggers `rides_f_webhooks_insert` / `rides_f_webhooks_update` (`private.queue_ride_webhooks`)
   insèrent une ligne de `webhook_deliveries` par adresse abonnée, dans la transaction de la course (type, statut avant et
   après, `occurred_at`), puis `pg_notify('rydar_webhooks')`. Aucune charge utile n'est stockée. Centrale suspendue ou
   archivée, ou offre sans l'API : aucun événement enregistré.
2. **Prise** (`private.claim_webhook_deliveries`, `SKIP LOCKED`, bail de 2 min) : un seul envoi en cours par adresse (le
   plus ancien dû d'abord), tour de rôle entre centrales ; les envois d'une centrale suspendue ou archivée restent en
   file. La ligne renvoyée porte l'adresse, le secret (`webhook_endpoint_secrets`) et l'état ACTUEL de la course
   (`private.webhook_ride_json`, mêmes colonnes que `PUBLIC_RIDE_SELECT` de l'API v1 : `publicRide` de `@rydar/shared`
   sert aux deux, toute colonne ajoutée l'est des deux côtés).
3. **Envoi** (worker, `apps/worker/src/webhooks*`) : garde SSRF (nom résolu, refus si une seule adresse est privée,
   connexion à l'adresse vérifiée), corps signé HMAC-SHA256 (`X-Rydar-Signature`), réponse 2xx attendue en 10 s, aucune
   redirection suivie.
4. **Compte rendu** (`private.complete_webhook_delivery`) : succès, ou nouvel essai (1 min → 24 h, 9 essais ; un `ping`
   n'est jamais réessayé) ; désactivation automatique après au moins 50 échecs consécutifs ET aucun envoi réussi depuis
   3 jours (depuis la création pour une adresse qui n'a jamais réussi).
5. **Purge** (`private.purge_webhook_deliveries`, toutes les heures) : 30 jours, 45 au plus pour un envoi resté en file.

Gestion : API v1 (`/api/v1/webhooks`, permission `webhooks:manage`) et Dashboard → Intégrations (owner / admin), toutes
deux par les RPC `svc_webhook_*` (service role) qui revérifient l'appartenance à la centrale et écrivent `audit_logs`.
Tests et renvois bornés : un `ping` en attente par adresse (`WEBHOOK_TEST_PENDING`), 10 par minute et par centrale
(`WEBHOOK_TEST_RATE_LIMITED`, aussi compté côté web dans Redis).

## Géolocalisation chauffeur

L'app envoie sa position avec `update_driver_location`. La fonction répond avec l'intervalle d'envoi conseillé : environ **5 s** en course, **15 s** en attente, **120 s** à l'arrêt prolongé. La tâche de fond `expo-location` adapte sa précision et sa fréquence en conséquence, pour économiser la batterie. La dernière position est *upsertée* dans `driver_locations` (colonne `geography` générée, index GiST). L'historique est échantillonné dans `driver_location_history`, puis purgé par le ménage.

## Rôles

| Rôle | Portée | Peut |
| --- | --- | --- |
| Super Admin (`users.is_super_admin`) | Plateforme | Créer, suspendre et archiver des organisations, choisir leur modèle (flotte / centrale) et les frais plateforme, donner les accès, gérer les offres et les limites, voir l'activité de toutes les organisations, bannir de toute la plateforme |
| `owner` / `admin` | Une organisation | Tout gérer dans l'organisation : chauffeurs, réglages, clés API, équipe, abonnement, lien d'inscription et candidatures (flotte comme centrale), bannissements ; en mode centrale : annulation de dettes |
| `dispatcher` | Une organisation | Créer, attribuer et annuler des courses, suivre la flotte ; en mode centrale : confirmer ou contester les paiements, relancer |
| Chauffeur (`drivers.user_id`) | Ses offres et ses courses | Passer EN LIGNE / HORS LIGNE, envoyer sa position, accepter ou refuser, faire avancer **ses** courses |

## Formulaire de contact et e-mails

Le site vitrine (`/`, `/services`, `/avantages`, `/tarifs`, `/faq`, `/contact`) n'a plus de lien « démo » : « Demander
un tarif » et les boutons des offres ouvrent `/contact?sujet=tarif[&offre=code]`. L'action serveur (`lib/contact.ts`)
écarte les robots (champ piège), valide (`contactRequestSchema` de `@rydar/shared`), limite (IP /64 : 5 par heure,
adresse : 3 par jour, 200 par heure en tout), puis appelle `svc_contact_submit` (service role) qui enregistre la demande
(`contact_requests`) et met en file, dans la même transaction, la notification à l'admin (`CONTACT_NOTIFY_EMAIL`, sinon
e-mail de `/admin/legal`, adresses validées comme en base) et un accusé de réception au contenu fixe (un par adresse et
par 24 h, 30 par heure en tout). Le site n'envoie aucun e-mail : le service `mailer` les envoie au serveur mail du VPS.
Le super admin traite les demandes dans `/admin/contacts` (statut, note, réponse par e-mail, suppression, nouvel essai,
e-mail de test) ; lecture par RLS (super admin seul), écritures par le service role et `audit()`. Conservation :
demande 3 ans, indésirable 30 jours après son classement, empreinte d'IP 1 an (`private.purge_contact_data`, ménage du
worker).

