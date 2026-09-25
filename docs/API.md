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
- La clé est une donnée **serveur**. Appelez l'API depuis le back-end de votre site (PHP, WordPress, Node…), jamais depuis du JavaScript exécuté dans le navigateur du client. Pour un site sans back-end, utilisez le mini-site de réservation (voir plus bas). Les appels navigateur ne reçoivent les en-têtes CORS que pour les origines déclarées sur la clé.
- Côté Rydar, seul un hash **HMAC-SHA-256** (poivré) de la clé est stocké, dans une table inaccessible aux clients. La comparaison se fait en temps constant.
- Chaque clé a des **permissions** : `rides:create`, `rides:read`, `rides:cancel`. Elle a aussi un **débit** (60 requêtes/min par défaut) et peut recevoir une date d'expiration. Elle se révoque instantanément depuis le dashboard.

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
  -H "Idempotency-Key: resa-2026-0412-8842" \
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

**Idempotence** : avec un en-tête `Idempotency-Key`, un renvoi de la même requête (après un timeout réseau, par exemple) renvoie **200** et `"idempotent_replay": true` au lieu de créer un doublon.

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
| 403 | `FORBIDDEN_TENANT_FIELD`, `FORBIDDEN_TENANT`, `INSUFFICIENT_SCOPE`, `ORGANIZATION_INACTIVE`, `PLAN_FEATURE_API` |
| 404 | `RIDE_NOT_FOUND` |
| 409 | codes métier d'annulation (ex. course déjà terminée) |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `VALIDATION_ERROR`, `PICKUP_NOT_GEOCODED`, `INVALID_COORDINATES`, `PICKUP_IN_PAST`, `PICKUP_TOO_FAR` |
| 429 | `RATE_LIMITED`, avec l'en-tête `Retry-After` |

Chaque réponse porte `X-Request-Id` et `X-RateLimit-Limit` / `-Remaining` / `-Reset`. Toutes les requêtes sont journalisées (`api_logs`, 90 jours) et visibles dans **Intégrations**.

## Mini-site de réservation (sans code)

Offres Pro et Business. **Dashboard → Mini-site** permet d'activer une page de réservation aux couleurs de l'organisation : logo, couleur, textes, catégories proposées. Elle est servie par :

- `https://{slug}.rydar.app` (sous-domaine) ou `https://app.rydar.app/book/{slug}` ;
- un **domaine personnalisé** (Business), par exemple `reservation.ma-centrale.fr`, via un CNAME vers l'application ;
- une **iframe** intégrée à un site existant : `<iframe src="https://app.rydar.app/book/{slug}" …>`.

Le client ne crée **aucun compte**. Le formulaire est protégé par un pot de miel anti-robot, une limite de débit par IP (6 envois / 10 min) et un consentement RGPD explicite. La course arrive avec la source `booking_site` et suit le même dispatch.
