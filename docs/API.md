# API publique v1

L'API permet au **site internet du rattacheur** d'envoyer ses réservations directement dans Rydar Drive. La course entre dans le dispatch comme une course créée depuis le dashboard.

- Base : `https://app.rydar.app/api/v1` (ou `NEXT_PUBLIC_APP_URL`)
- Format : JSON UTF-8. Dates en ISO 8601. Montants en **centimes**.
- Disponible dans les offres **Pro** et **Business** (`api_access`).

## Authentification

Créez une clé dans **Dashboard → Intégrations → Clés API**. Elle n'est affichée **qu'une seule fois** :

```
rdk_live_<préfixe 8 car.>_<secret 32 car.>
```

Envoyez-la dans l'en-tête `Authorization: Bearer rdk_live_…`, ou `X-API-Key`.

- **La clé identifie l'organisation.** Il n'existe aucun paramètre `organization_id`. Si vous en envoyez un, la requête est refusée en **403 `FORBIDDEN_TENANT_FIELD`**.
- La clé est une donnée **serveur**. Appelez l'API depuis le back-end de votre site (PHP, WordPress, Node…), jamais depuis du JavaScript exécuté dans le navigateur du client. Pour un site sans back-end, utilisez le mini-site de réservation (voir plus bas).
- **Clé « navigateur »** (seule exception) : une clé qui a des **origines autorisées** (champ « Origines autorisées (CORS) » du dashboard) est lisible par tout visiteur du site, elle est donc restreinte, y compris si elle a été créée avant cette règle :
  - **création de course seulement** : elle ne peut avoir que la permission `rides:create` ; toute autre route (`GET /ping`, lecture, annulation, webhooks) répond **403 `INSUFFICIENT_SCOPE`** ;
  - **origine listée obligatoire** : en-tête `Origin` absent ou absent de la liste → **403 `ORIGIN_NOT_ALLOWED`**. Seules les origines listées reçoivent les en-têtes CORS. Attention : hors d'un navigateur (`curl`, serveur), l'en-tête `Origin` se forge ; la vraie protection d'une clé « navigateur » est sa portée (création de course seulement, prix et paiement ignorés, rejeu réduit), pas l'origine ;
  - **prix et paiement ignorés** : `price_cents` et `payment_method` de la requête ne sont pas pris en compte ; le prix est calculé avec la grille de l'organisation et le moyen de paiement est `card` (valeur par défaut).
- Côté Rydar, seul un hash **HMAC-SHA-256** (poivré) de la clé est stocké, dans une table inaccessible aux clients. La comparaison se fait en temps constant.
- Chaque clé a des **permissions** : `rides:create`, `rides:read`, `rides:cancel`, `webhooks:manage` (gérer les webhooks, voir plus bas). Elle a aussi un **débit** (60 requêtes/min par défaut) et peut recevoir une date d'expiration. Elle se révoque instantanément depuis le dashboard.
- **Limite par adresse IP** (IPv6 regroupée par /64) pour les requêtes non authentifiées : au-delà de 20 échecs d'authentification par minute (clé absente, inconnue ou invalide), les suivants reçoivent 429 et ne sont plus journalisés. Une clé valide n'a que **son propre débit**, quelle que soit l'adresse (un serveur ou un intégrateur qui sert plusieurs organisations depuis une même IP n'est pas plafonné). Les refus d'une clé reconnue (révoquée, expirée, origine non autorisée, débit dépassé…) gardent leur réponse, mais sont journalisés au plus 20 fois par minute et par clé.

Test rapide :

```bash
curl https://app.rydar.app/api/v1/ping -H "Authorization: Bearer $RYDAR_API_KEY"
# {"ok":true,"organization_id":"…","scopes":["rides:create","rides:read"],"request_id":"…"}
```

## Créer une course : `POST /rides`

Permission `rides:create`.

```bash
curl https://app.rydar.app/api/v1/rides \
  -H "Authorization: Bearer $RYDAR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 5f0c2b8e-9d4a-4c61-8f2e-7a3b1c9d0e64" \
  -d '{
    "pickup":  { "address": "Hôtel Plaza Athénée, 25 Avenue Montaigne, 75008 Paris", "lat": 48.8663, "lng": 2.3040 },
    "dropoff": { "address": "Aéroport Paris-Charles de Gaulle, Terminal 2E" },
    "date": "2026-10-12", "time": "07:30",
    "customer": { "name": "Claire Martin", "phone": "06 12 34 56 78", "email": "claire@example.com" },
    "passengers": 2, "luggage": 2,
    "vehicle_category": "business",
    "price_cents": 8500,
    "payment_method": "card",
    "flight_number": "AF1234",
    "comment": "Panneau au nom du client",
    "external_reference": "WEB-8842"
  }'
```

| Champ | Type | Obligatoire | Détail |
| --- | --- | --- | --- |
| `pickup.address` | string | oui | 3 à 300 caractères |
| `pickup.lat`, `pickup.lng` | number | recommandé | Sans coordonnées, l'adresse est géocodée, avec priorité à votre zone d'activité. Si elle est introuvable ou imprécise (ville seule, rue inconnue, code postal incohérent), la réponse est 422 `PICKUP_NOT_GEOCODED`. Un nom de lieu en tête est accepté (« Hôtel X, 25 avenue … »). Les coordonnées fournies sont contrôlées : (0, 0), latitude et longitude inversées ou point à plus de 600 km de votre activité donnent 422 `INVALID_COORDINATES` |
| `dropoff.address` (+ `lat`, `lng`) | string | oui | Géocodage facultatif |
| `pickup_at` | ISO 8601 avec fuseau | non | **ou** `date` (AAAA-MM-JJ) + `time` (HH:MM), heure locale de l'organisation. Sans date, la course est immédiate |
| `customer.name`, `customer.phone` | string | oui | Téléphone normalisé (formats FR et internationaux) |
| `customer.email` | string | non | |
| `passengers` | 1–20 | non | Défaut 1 |
| `luggage` | 0–30 | non | Défaut 0 |
| `vehicle_category` | `standard` · `business` · `first` · `van` · `green` | non | Défaut `standard` |
| `price_cents` | entier | non | Prix annoncé au client, affiché au chauffeur. Absent : calculé avec la grille de l'organisation (forfait reconnu, par ex. « Paris ↔ CDG », sinon tarif au km et à la minute). Compte en mode centrale : la part chauffeur, la commission et les frais sont calculés automatiquement à partir de ce prix |
| `payment_method` | `card` · `cash` · `online` · `invoice` · `account` | non | Défaut `card` |
| `flight_number`, `comment`, `external_reference` | string | non | `external_reference` : votre identifiant de réservation (100 car. max) |

Tout champ inconnu est refusé (422). Une prise en charge dans moins de 45 min (seuil réglable) donne une course **instantanée**, dispatchée tout de suite par GPS. Au-delà, la course est **planifiée** et proposée à la flotte.

Réponse **201** :

```json
{
  "data": {
    "id": "8d0c…", "number": 1928, "type": "scheduled", "status": "OFFERED",
    "pickup": { "address": "Hôtel Plaza Athénée…", "lat": 48.8663, "lng": 2.304 },
    "dropoff": { "address": "Aéroport Paris-Charles de Gaulle, Terminal 2E", "lat": 49.0047, "lng": 2.571 },
    "pickup_at": "2026-10-12T05:30:00+00:00",
    "passengers": 2, "luggage": 2, "vehicle_category": "business",
    "price_cents": 8500, "currency": "EUR", "payment_method": "card",
    "flight_number": "AF1234", "external_reference": "WEB-8842",
    "route": { "distance_m": 31840, "duration_s": 2460, "polyline": "o~diHwfuM…" },
    "driver": null,
    "timestamps": { "created_at": "…", "accepted_at": null, "driver_arrived_at": null, "started_at": null, "completed_at": null, "cancelled_at": null },
    "links": { "self": "https://app.rydar.app/api/v1/rides/8d0c…" }
  }
}
```

L'itinéraire routier (`route`) est calculé par Rydar à la création : distance, durée et tracé encodé en *polyline* (précision 5, format Google/OSRM).

**Idempotence** : avec un en-tête `Idempotency-Key` (une valeur unique et imprévisible par réservation, un UUID par exemple ; 100 caractères au plus), un renvoi de la même requête **par la même clé API** (après un timeout réseau, par exemple) renvoie **200** et `"idempotent_replay": true` au lieu de créer un doublon. La valeur est unique pour toute l'organisation : déjà utilisée par une autre clé → **409 `IDEMPOTENCY_KEY_CONFLICT`**, sans jamais renvoyer la course existante. Avec une clé « navigateur », le rejeu ne renvoie que `{ "id", "number", "status" }`.

## Suivre une course

| Requête | Permission | Détail |
| --- | --- | --- |
| `GET /rides/{id}` | `rides:read` | Une fois le chauffeur attribué, `driver` vaut `{ first_name, vehicle: { model, color, plate } }` |
| `GET /rides?external_reference=WEB-8842&status=COMPLETED&limit=20` | `rides:read` | 100 résultats au plus, les plus récents d'abord |
| `POST /rides/{id}/cancel` `{ "reason": "…" }` | `rides:cancel` | 409 si la course est déjà terminée ou annulée |

Statuts : `CREATED`, `SEARCHING_DRIVER`, `OFFERED`, `ACCEPTED`, `DRIVER_EN_ROUTE`, `DRIVER_ARRIVED`, `PASSENGER_ONBOARD`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `NO_DRIVER_FOUND`.

Lire ou annuler la course d'une **autre** organisation renvoie **403 `FORBIDDEN_TENANT`**. La tentative est enregistrée dans l'audit, avec la gravité *critique*.

## Erreurs

Format commun :

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Données de réservation invalides.", "details": { "customer.phone": ["Numéro de téléphone invalide"] }, "request_id": "…" } }
```

| HTTP | Codes |
| --- | --- |
| 400 | `INVALID_JSON` |
| 401 | `INVALID_API_KEY`, `API_KEY_REVOKED`, `API_KEY_EXPIRED` |
| 402 | `PLAN_LIMIT_RIDES` (quota mensuel de l'offre atteint) |
| 402 | `PLATFORM_FEES_OVERDUE` (centrale, ou flotte avec des frais Rydar : frais en retard, création de courses suspendue par Rydar) |
| 403 | `FORBIDDEN_TENANT_FIELD`, `FORBIDDEN_TENANT`, `INSUFFICIENT_SCOPE`, `ORIGIN_NOT_ALLOWED` (clé « navigateur »), `ORGANIZATION_INACTIVE`, `PLAN_FEATURE_API` |
| 404 | `RIDE_NOT_FOUND`, `WEBHOOK_NOT_FOUND` |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` (valeur déjà utilisée par une autre clé), codes métier d'annulation (ex. course déjà terminée), `WEBHOOK_LIMIT` (10 adresses au plus), `WEBHOOK_DISABLED` (test d'une adresse désactivée) |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `VALIDATION_ERROR`, `PICKUP_NOT_GEOCODED`, `INVALID_COORDINATES`, `PICKUP_IN_PAST`, `PICKUP_TOO_FAR`, `WEBHOOK_INVALID_URL`, `WEBHOOK_INVALID_EVENTS`, `WEBHOOK_INVALID_SECRET` |
| 429 | `RATE_LIMITED` (débit de la clé, ou trop d'échecs d'authentification depuis une même adresse), avec l'en-tête `Retry-After` |

Chaque réponse porte `X-Request-Id` et `X-RateLimit-Limit` / `-Remaining` / `-Reset`. Les requêtes sont journalisées (`api_logs`, 90 jours) et visibles dans **Intégrations**, sauf les échecs d'authentification au-delà de 20 par minute et par IP, et les refus d'une clé reconnue au-delà de 20 par minute et par clé.

## Webhooks

Rydar Drive prévient votre serveur à chaque changement de statut d'une course : il envoie une requête **POST JSON signée** à l'adresse https que vous avez enregistrée. Vous n'avez plus besoin d'interroger `GET /rides/{id}` en boucle.

### Enregistrer une adresse

- **Dashboard → Intégrations → Webhooks** (owner ou admin, offres avec l'API) : « Nouvelle adresse », choix des événements, puis le **secret de signature**, affiché **une seule fois** (bouton « Copier »). Pour chaque adresse : envoi de test, désactivation et réactivation, nouveau secret (l'ancien cesse aussitôt de signer), suppression. Les envois sont listés **adresse par adresse** : les 10 derniers de chaque adresse, plus ses **10 derniers envois en échec**, même plus anciens (bouton **« Renvoyer »**), avec leur état, le code HTTP reçu, le nombre d'essais (l'essai réussi compris) et le prochain essai.
- **Tests et renvois bornés** : un seul test (`ping`) en attente par adresse (`409 WEBHOOK_TEST_PENDING` tant que son résultat n'est pas connu : en file ou en cours d'envoi), et **10 tests et renvois par minute** au plus par centrale, dashboard et API confondus (`429 WEBHOOK_TEST_RATE_LIMITED`, avec `Retry-After`).
- Ou par l'API, avec une clé qui a la permission `webhooks:manage` (voir [Gérer les webhooks par l'API](#gérer-les-webhooks-par-lapi)).
- **10 adresses** au plus par organisation. Adresse acceptée : `https://` obligatoire, **publique** (ni `localhost`, ni adresse IP privée, réservée ou de lien local, ni nom de réseau local comme `.local` ou `.internal`), sans identifiants (`https://user:mot-de-passe@…` refusé), 500 caractères au plus. Les redirections ne sont **pas** suivies.

### Événements

| Type | Envoyé quand | `data.status` |
| --- | --- | --- |
| `ride.created` | Course créée (dashboard, API, mini-site) | statut initial |
| `ride.accepted` | Un chauffeur accepte la course, ou un autre chauffeur la reprend (réattribution) | `ACCEPTED` |
| `ride.driver_unassigned` | La course avait un chauffeur et repart en recherche | `CREATED`, `SEARCHING_DRIVER` ou `OFFERED` |
| `ride.driver_en_route` | Le chauffeur part vers le point de départ | `DRIVER_EN_ROUTE` |
| `ride.driver_arrived` | Le chauffeur est au point de départ | `DRIVER_ARRIVED` |
| `ride.passenger_onboard` | Le client est à bord | `PASSENGER_ONBOARD` |
| `ride.in_progress` | Trajet vers la destination | `IN_PROGRESS` |
| `ride.completed` | Course terminée | `COMPLETED` |
| `ride.cancelled` | Course annulée (dashboard, API, ou « Non effectuée » 6 h après l'heure d'une course planifiée jamais démarrée) | `CANCELLED` |
| `ride.no_driver_found` | Recherche terminée sans chauffeur | `NO_DRIVER_FOUND` |
| `ride.search_restarted` | La course restée sans chauffeur repart en recherche (« Relancer », vol retardé qui la remet en service) ; `data.previous_status` = `NO_DRIVER_FOUND` | `CREATED`, `SEARCHING_DRIVER` ou `OFFERED` |
| `ride.rescheduled` | Heure de prise en charge modifiée (course ni terminée, ni annulée ; course sans chauffeur comprise, son heure suit le vol) ; peut accompagner un autre événement de la même modification | statut courant |
| `ping` | Envoi de test (bouton du dashboard ou `POST /webhooks/{id}/test`), jamais abonnable | `data` vide (`{}`) |

Les étapes internes du dispatch (vagues, offres aux chauffeurs) ne produisent aucun événement. Une adresse abonnée à **tous** les événements (liste vide, par défaut) recevra aussi ceux ajoutés plus tard.

### Format d'un envoi

```http
POST /api/rydar/webhook HTTP/1.1
Content-Type: application/json; charset=utf-8
User-Agent: RydarDrive-Webhooks/1.0
X-Rydar-Event: ride.accepted
X-Rydar-Delivery: 0b6f3c1e-2d4a-4f7e-9c51-8a2e6d0b7f43
X-Rydar-Timestamp: 1791090131
X-Rydar-Signature: v1=5d1c0f…e94a
```

```json
{
  "id": "0b6f3c1e-2d4a-4f7e-9c51-8a2e6d0b7f43",
  "type": "ride.accepted",
  "created_at": "2026-10-12T05:02:11.482Z",
  "api_version": "2026-10-01",
  "data": {
    "ride": {
      "id": "8d0c…", "number": 1928, "type": "scheduled", "status": "ACCEPTED",
      "pickup": { "address": "Hôtel Plaza Athénée…", "lat": 48.8663, "lng": 2.304 },
      "dropoff": { "address": "Aéroport Paris-Charles de Gaulle, Terminal 2E", "lat": 49.0047, "lng": 2.571 },
      "pickup_at": "2026-10-12T05:30:00+00:00",
      "passengers": 2, "luggage": 2, "vehicle_category": "business",
      "price_cents": 8500, "currency": "EUR", "payment_method": "card",
      "flight_number": "AF1234", "external_reference": "WEB-8842",
      "route": { "distance_m": 31840, "duration_s": 2460, "polyline": "o~diHwfuM…" },
      "driver": { "first_name": "Karim", "vehicle": { "model": "Mercedes Classe E", "color": "Noir", "plate": "GA-123-BC" } },
      "timestamps": { "created_at": "…", "accepted_at": "2026-10-12T05:02:11+00:00", "driver_arrived_at": null, "started_at": null, "completed_at": null, "cancelled_at": null },
      "links": { "self": "https://app.rydar.app/api/v1/rides/8d0c…" },
      "updated_at": "2026-10-12T05:02:11.471+00:00"
    },
    "status": "ACCEPTED",
    "previous_status": "OFFERED"
  }
}
```

- `id` (identique à `X-Rydar-Delivery`) : identifiant de l'envoi, **le même à chaque nouvel essai**.
- `created_at` : moment de l'événement. `data.status` et `data.previous_status` : la transition qui l'a provoqué (`previous_status` vaut `null` pour `ride.created`).
- `data.ride` : la course telle que la renvoie `GET /rides/{id}`, plus `updated_at`, **dans son état au moment de l'envoi** (le plus récent), pas au moment de l'événement. Elle vaut `null` si la course n'existe plus. Aucune charge utile n'est conservée par Rydar : elle est construite à l'envoi.
- Aucune donnée du client (nom, téléphone, e-mail) n'est envoyée : retrouvez votre réservation grâce à `external_reference`.

### Vérifier la signature

`X-Rydar-Signature` vaut `v1=` suivi du **HMAC-SHA256** (hexadécimal, minuscules) du texte `<X-Rydar-Timestamp>.<corps brut>`, avec le secret de l'adresse. Le serveur qui reçoit doit :

1. lire le **corps brut**, avant tout `JSON.parse` (un JSON re-sérialisé ne donne pas la même signature) ;
2. vérifier le **format** de l'en-tête (`v1=` suivi de 64 caractères hexadécimaux) **avant** de comparer : en Node.js, `timingSafeEqual` lève une exception si les deux valeurs n'ont pas la même longueur en octets, et un en-tête forgé (caractère accentué, par exemple) suffirait à faire planter le serveur ; puis calculer la signature attendue et la comparer **en temps constant** ;
3. refuser un `X-Rydar-Timestamp` à plus de **5 minutes** de son horloge (dans le passé comme dans le futur). L'horodatage est celui de **cet** essai : un envoi réessayé des heures plus tard porte un horodatage et une signature neufs ;
4. répondre `401` si la vérification échoue, `2xx` sinon.

Node.js (Express) :

```js
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

const app = express();
// Corps brut obligatoire : pas de express.json() sur cette route
app.post("/api/rydar/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  // Express 4 n'attrape pas les erreurs d'une fonction async : sans try/catch, une exception peut arrêter le processus
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const ts = req.get("X-Rydar-Timestamp") ?? "";
    const sig = req.get("X-Rydar-Signature") ?? "";
    const expected = "v1=" + createHmac("sha256", process.env.RYDAR_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest("hex");
    const fresh = /^\d+$/.test(ts) && Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
    // Format contrôlé AVANT timingSafeEqual (exception si les longueurs en octets diffèrent)
    const valid = /^v1=[0-9a-f]{64}$/.test(sig) && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!fresh || !valid) return res.sendStatus(401);

    const event = JSON.parse(raw);
    if (await alreadyProcessed(event.id)) return res.sendStatus(200); // doublon : déjà traité
    await enqueue(event); // traitement asynchrone : répondre vite
    res.sendStatus(204);
  } catch {
    res.sendStatus(500); // Rydar Drive réessaiera plus tard
  }
});
```

PHP :

```php
<?php
$secret = getenv('RYDAR_WEBHOOK_SECRET');
$raw = file_get_contents('php://input');           // corps brut
$ts  = $_SERVER['HTTP_X_RYDAR_TIMESTAMP'] ?? '';
$sig = $_SERVER['HTTP_X_RYDAR_SIGNATURE'] ?? '';
$expected = 'v1=' . hash_hmac('sha256', $ts . '.' . $raw, $secret);

if (!ctype_digit($ts) || abs(time() - (int) $ts) > 300 || !hash_equals($expected, $sig)) {
    http_response_code(401);
    exit;
}
$event = json_decode($raw, true);
// Dédoublonner sur $event['id'] (colonne à clé unique), puis traiter
http_response_code(204);
```

### Nouveaux essais et désactivation

- **Succès** = réponse `2xx` en moins de **10 secondes** (le corps de la réponse est ignoré). Tout le reste est un échec : délai dépassé, erreur réseau ou TLS, redirection `3xx`, `4xx`, `5xx`.
- Après un échec, nouvel essai au bout de **1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h puis 24 h** : 9 essais en tout sur environ 46 heures. L'envoi passe ensuite « en échec » ; « Renvoyer » (dashboard) le remet en file, compteur à zéro. Un test (`ping`) n'est **jamais** réessayé : en échec dès le premier échec, un autre test est possible aussitôt.
- **Désactivation automatique** : seulement après **au moins 50 échecs consécutifs ET aucun envoi réussi depuis 3 jours** ; pour une adresse qui n'a encore jamais réussi, ces 3 jours sont comptés depuis sa création (un serveur pas encore déployé ou un secret mal recopié laisse donc 3 jours pour corriger). L'adresse est alors désactivée (motif affiché dans le dashboard) et ses envois en attente passent en échec. Réactivez-la depuis le dashboard, ou renvoyez `POST /webhooks` avec la même adresse.
- **Centrale suspendue ou archivée** : envois **en pause** (aucun nouvel événement enregistré ; les envois déjà en file y restent, repris à la réactivation). Une offre qui n'inclut plus l'API n'enregistre plus d'événement ; les envois déjà en file partent normalement.
- Historique des envois : 30 jours (45 jours au plus pour un envoi resté en file).

### Ordre et doublons

- **Au moins une fois** : un événement peut arriver deux fois (par exemple si votre serveur a répondu après les 10 secondes). Dédoublonnez sur `id`.
- **Un seul envoi à la fois par adresse**, le plus ancien dû d'abord : les événements d'une adresse partent dans l'ordre où ils se sont produits, et une adresse lente n'occupe qu'une requête à la fois (tour de rôle entre centrales) : elle ne retarde presque pas vos autres adresses.
- **Ordre non garanti pour autant** : un envoi en échec attend son nouvel essai sans bloquer les suivants, qui peuvent donc arriver avant lui (de même pour « Renvoyer »). Ne faites jamais reculer une course : comparez `data.ride.updated_at` à la dernière valeur enregistrée et ignorez un état plus ancien. Comme `data.ride` est l'état le plus récent au moment de l'envoi, fiez-vous à `data.ride.status` plutôt qu'au seul type d'événement.
- **Répondez vite** (`2xx`) et traitez ensuite (file, tâche de fond) : un traitement long fait échouer l'envoi et provoque des doublons.

### Sécurité

- Le secret est rangé dans une table inaccessible à tout rôle client ; il n'est affiché qu'à la création ou au renouvellement, jamais renvoyé ensuite ni journalisé.
- Protection contre les requêtes forgées vers le réseau interne (SSRF) : seules les adresses **https publiques** sont acceptées. Avant chaque envoi, le serveur d'envoi résout le nom et refuse l'envoi si **une seule** des adresses obtenues est privée, de boucle locale, de lien local, CGNAT, multidiffusion ou non spécifiée (IPv4, IPv6 et formes IPv4 dans IPv6), puis se connecte à l'adresse vérifiée elle-même (pas de second appel DNS : pas de *DNS rebinding*).

### Gérer les webhooks par l'API

Permission `webhooks:manage` (jamais pour une clé « navigateur »). Mêmes authentification, limites et journal que le reste de l'API.

| Requête | Réponse |
| --- | --- |
| `GET /webhooks` | **200** `{ "data": [adresse…] }` |
| `POST /webhooks` | **201** (nouvelle adresse) ou **200** (adresse déjà enregistrée) |
| `DELETE /webhooks/{id}` | **204**, ou **404 `WEBHOOK_NOT_FOUND`** |
| `POST /webhooks/{id}/test` | **202** `{ "data": { "delivery_id": "…" } }` : un `ping` part aussitôt ; **409 `WEBHOOK_DISABLED`** si l'adresse est désactivée ; **409 `WEBHOOK_TEST_PENDING`** tant que le résultat du test précédent de cette adresse n'est pas connu (en file ou en cours d'envoi) ; **429 `WEBHOOK_TEST_RATE_LIMITED`** (+ `Retry-After`) au-delà de 10 tests et renvois par minute pour la centrale (toutes clés et dashboard confondus) |

Corps de `POST /webhooks` (tout champ inconnu est refusé en 422, `organization_id` en 403) :

| Champ | Détail |
| --- | --- |
| `url` | obligatoire, voir les règles plus haut (`WEBHOOK_INVALID_URL`) |
| `description` | facultatif, 120 caractères au plus ; retours à la ligne, tabulations et caractères de contrôle remplacés par une espace |
| `events` | facultatif : liste de types ; absent ou vide = tous (`WEBHOOK_INVALID_EVENTS` pour un type inconnu) |
| `secret` | facultatif : 32 à 200 caractères `A-Z a-z 0-9 _ . -` (`WEBHOOK_INVALID_SECRET`). Absent : Rydar génère `whsec_…` et le renvoie **une seule fois** |

```bash
curl https://app.rydar.app/api/v1/webhooks \
  -H "Authorization: Bearer $RYDAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://www.mon-site.fr/api/rydar/webhook", "description": "Site de réservation", "events": ["ride.accepted", "ride.completed", "ride.cancelled"] }'
```

Réponse **201** :

```json
{
  "data": {
    "id": "5a3e…", "url": "https://www.mon-site.fr/api/rydar/webhook", "description": "Site de réservation",
    "events": ["ride.accepted", "ride.completed", "ride.cancelled"], "enabled": true, "disabled_reason": null,
    "created_at": "2026-10-02T09:12:44+00:00", "last_success_at": null, "last_failure_at": null, "last_error": null
  },
  "secret": "whsec_3f9c…",
  "created": true
}
```

**Même adresse déjà enregistrée** : **200**, `"created": false`, `"secret": null`. La description et les événements sont remplacés, l'adresse est réactivée (compteur d'échecs remis à zéro) et le secret n'est changé que si `secret` est fourni. Un serveur peut donc s'enregistrer lui-même à chaque déploiement, avec son propre secret (tiré de sa configuration), sans que personne ne copie de secret : c'est ce que fait RYDAR Privé.

Les erreurs suivent le format commun : `422 VALIDATION_ERROR` (champ inconnu, plusieurs champs invalides), `422 WEBHOOK_INVALID_URL` / `WEBHOOK_INVALID_EVENTS` / `WEBHOOK_INVALID_SECRET`, `409 WEBHOOK_LIMIT` (10 adresses), `404 WEBHOOK_NOT_FOUND`, `409 WEBHOOK_DISABLED`, `409 WEBHOOK_TEST_PENDING`, `429 WEBHOOK_TEST_RATE_LIMITED`.

## Mini-site de réservation (sans code)

Offres Pro et Business. **Dashboard → Mini-site** permet d'activer une page de réservation aux couleurs de l'organisation : logo, couleur, textes, catégories proposées. Elle est servie par :

- `https://{slug}.rydar.app` (sous-domaine) ou `https://app.rydar.app/book/{slug}` ;
- un **domaine personnalisé** (Business), par exemple `reservation.ma-centrale.fr`, via un CNAME vers l'application ;
- une **iframe** intégrée à un site existant : `<iframe src="https://app.rydar.app/book/{slug}" …>`.

Le client ne crée **aucun compte**. Le formulaire est protégé par un pot de miel anti-robot, une limite de débit par IP (6 envois / 10 min) et un consentement RGPD explicite. La course arrive avec la source `booking_site` et suit le même dispatch.
