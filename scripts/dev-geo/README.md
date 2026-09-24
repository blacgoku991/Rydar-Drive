# Stack géo de dev (tuiles, routage, géocodage) — Paris & Nice

**Usage : développement / démo uniquement.** Remplace localement les services publics bloqués dans le bac
à sable (OpenFreeMap/CARTO, OSRM, API Adresse/Géoplateforme) par des équivalents construits à partir de
**vraies données Overture Maps** (release `2026-09-23.0`), avec **les mêmes formats d'API** que la production :

| Service | Remplace | Local | Format |
|---|---|---|---|
| Tuiles vectorielles | OpenFreeMap / CARTO | `http://localhost:3000/dev-map/tiles.json` (fichiers statiques servis par Next) | MVT, schéma **OpenMapTiles** |
| Routeur | `router.project-osrm.org` | `http://localhost:5001` | **OSRM v5** (`/route`, `/table`, `/nearest`) |
| Géocodeur | `api-adresse.data.gouv.fr`, `data.geopf.fr/geocodage` | `http://localhost:5002` | **API Adresse (BAN)** `/search`, `/reverse` + `/completion` (Géoplateforme) |

Zones couvertes (WGS84) : **Paris** lon 2.10→2.65, lat 48.68→49.06 (CDG, Orly, La Défense, Versailles inclus) ;
**Nice** lon 7.10→7.40, lat 43.62→43.78. Hors de ces zones : pas de données (404 sur les tuiles, `NoSegment`
pour le routeur, aucun résultat pour le géocodeur).

Attribution à afficher : **« © OpenStreetMap contributors, Overture Maps Foundation »**.
Licences des données : ODbL (données dérivées d'OpenStreetMap : réseau, bâtiments, eau, occupation du sol,
gares…), Licence Ouverte / etalab-2.0 (adresses BAN via OpenAddresses), CDLA-Permissive-2.0 (Overture places).
Rien de tout cela n'est commité : les données générées vivent dans `.dev-geo/` (gitignoré) et
`apps/web/public/dev-map/` (gitignoré).

## Démarrage rapide

```bash
bash scripts/dev-geo/build.sh      # ~3 min avec le cache (≈ 5 min la 1re fois : ~1,2 Go téléchargés en requêtes Range)
bash scripts/dev-geo/start.sh      # lance routeur (5001) + géocodeur (5002) détachés, attend /health
bash scripts/dev-geo/start.sh stop # arrête les deux
```

`build.sh` est idempotent et accepte des étapes : `deps extract tiles graph geocoder fonts`
(ex. `bash scripts/dev-geo/build.sh graph geocoder`). Pour forcer un re-téléchargement Overture, supprimer
le fichier concerné dans `.dev-geo/cache/overture/`. Ports : `ROUTER_PORT`, `GEOCODER_PORT` (start.sh) ou
`PORT` (serveurs lancés à la main : `PORT=5001 node scripts/dev-geo/router.mjs`).

Pré-requis : Python ≥ 3.10, Node 22, `curl`, `lsof` (ou `fuser`). Les dépendances sont installées **hors
workspace** : venv Python `.dev-geo/venv` (pyarrow, shapely, numpy, scipy, requests) et modules Node
`.dev-geo/node` (geojson-vt, vt-pbf). Aucun `package.json` du repo n'est modifié. Derrière un proxy TLS,
`REQUESTS_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS` sont positionnés automatiquement si `/root/.ccr/ca-bundle.crt`
existe (jamais de désactivation de la vérification TLS).

## Pipeline

```
Overture S3 (GeoParquet, HTTP Range)
  └─ extract.py ─────────► .dev-geo/cache/overture/<type>__<zone>.parquet   (footers → row groups intersectant la zone)
       ├─ prepare_tiles.py ► .dev-geo/layers/<couche>.ndjson  ─ tiles.mjs ─► apps/web/public/dev-map/tiles/{z}/{x}/{y}.pbf + tiles.json
       ├─ build_graph.py ──► .dev-geo/graph.{bin,json}  ──────── router.mjs   (:5001)
       └─ build_geocoder.py► .dev-geo/geocoder/{docs.json,addr.bin} ─ geocoder.mjs (:5002)
```

| Fichier | Rôle |
|---|---|
| `overture_io.py` | Lecture HTTP Range des GeoParquet Overture (footers, stats `bbox.*` par row group). |
| `extract.py` | Extraction régionale mise en cache (segments, eau, sol, infrastructure, bâtiments, divisions, places, adresses). |
| `overture_rules.py` | Interprétation des segments : sens uniques / accès (`access_restrictions`), bretelles, vitesses max. |
| `prepare_tiles.py` | Conversion vers les couches/attributs OpenMapTiles (+ `_minzoom` par feature). |
| `tiles.mjs` | Découpage geojson-vt par tranche de zoom + encodage MVT (vt-pbf), TileJSON 3. |
| `style-test.json` | Style MapLibre v8 de contrôle qui dessine toutes les couches (copié dans `public/dev-map/`). |
| `shots.mjs` | Captures Playwright (Chromium SwiftShader) de contrôle → `.dev-geo/shots/`. |
| `build_graph.py` / `router.mjs` | Graphe routier + serveur OSRM v5. |
| `notable.json` | Lieux notables (aéroports/terminaux, grands sites) : noms propres, alias (`cdg`, `roissy`…), position de secours. |
| `build_geocoder.py` / `geocoder.mjs` | Index + serveur API Adresse. |
| `build.sh` / `start.sh` | Orchestration. |

## Tuiles (schéma OpenMapTiles)

`apps/web/public/dev-map/tiles/{z}/{x}/{y}.pbf` — MVT v2 non compressé, extent 4096, zooms **5–15**
(4 969 tuiles, ≈ 111 Mo) ; `tiles.json` (TileJSON 3, `tiles: ["http://localhost:3000/dev-map/tiles/{z}/{x}/{y}.pbf"]`,
URL de base modifiable via `DEV_MAP_BASE_URL` au build). Glyphes : `apps/web/public/dev-map/fonts/{fontstack}/{range}.pbf`
(« Noto Sans Regular / Medium / Italic », toutes les plages 0–65535, depuis protomaps/basemaps-assets).

| Couche | Attributs | Source Overture | Zooms |
|---|---|---|---|
| `water` | `class` ocean/lake/river/pond/swimming_pool, `intermittent`, `brunnel` | base/water (polygones ; Seine = river) | selon surface (océan/Seine dès z5) |
| `waterway` | `class` river/canal/stream/ditch/drain, `name`, `brunnel` | base/water (lignes) | river 8, canal 10, stream 12 |
| `water_name` | `class` sea/bay/lake, `name` | baies, lacs nommés, « Mer Méditerranée » | 9+ |
| `landcover` | `class` wood/grass/farmland/sand/wetland/rock, `subclass` | base/land + base/land_use (herbe, jardins, cultures, golf…) | selon surface |
| `landuse` | `class` residential/industrial/commercial/retail/cemetery/hospital/school/university/stadium/pitch/railway/military… | base/land_use | selon surface |
| `park` | `class` park/nature_reserve/protected_area, `name` (+ points de libellé avec `rank`) | base/land_use | selon surface |
| `transportation` | `class` motorway/trunk/primary/secondary/tertiary/minor/service/track/path/rail/transit, `subclass` (path, rail), `brunnel` bridge/tunnel (découpé sur les plages `between`), `ramp` 1, `oneway` 1/-1, `service` | transportation/segment | motorway/trunk 5, primary 7, secondary/tertiary 10, minor/service 13, paths 14 (trottoirs 15), rail 10, transit 12 |
| `transportation_name` | `name` (+ `name_en`, `name:latin`), `ref`, `ref_length`, `network`, `class` | segments fusionnés par (nom, classe, ref) | motorway 8 … minor 14, service/path 15 |
| `building` | `render_height`, `render_min_height` | buildings (centre de Paris 2.22→2.47 × 48.80→48.92, centre de Nice 7.22→7.30 × 43.68→43.73) | 14–15 |
| `place` | `class` city/town/village/hamlet/suburb/quarter/neighbourhood, `name`, `rank`, `capital` | divisions (communes, arrondissements, quartiers ; grandes villes de France à z5–8) | city 5–8, town 9–11, village 12, suburb 12, quarter 13… |
| `aeroway` | `class` aerodrome/runway/taxiway/apron/helipad/heliport, `ref` | base/infrastructure (airport) | 8–14 |
| `aerodrome_label` | `name`, `iata`, `icao`, `class`, `ele` | idem (tags OSM) | international 8 |
| `poi` | `class`/`subclass` (railway/station, railway/subway, attraction, museum, stadium, hospital…), `name`, `rank` | gares/métro (OSM), lieux notables, hôpitaux/universités/stades nommés | 12–15 |

Les noms de couches/attributs sont ceux d'OpenMapTiles : un même style fonctionne sur ces tuiles et sur
OpenFreeMap (seule l'URL de la source change). Style de test : `http://localhost:3000/dev-map/style-test.json`.

Contrôle visuel : `node scripts/dev-geo/shots.mjs` (sert lui-même MapLibre + tuiles, n'a pas besoin de Next) ;
`ROUTE="2.3743,48.8443;2.571,49.0047" ROUTE_NAME=gdl-cdg node scripts/dev-geo/shots.mjs` trace un itinéraire du routeur.

## Routeur (OSRM v5) — `router.mjs`, port 5001

- `GET /route/v1/driving/{lon},{lat};{lon},{lat}[;…]?overview=full|simplified|false&geometries=polyline|polyline6|geojson&steps=true|false&annotations=…`
  → `{ code: "Ok", routes: [{ geometry, legs: [{ distance, duration, weight, summary, steps }], weight_name: "duration", weight, duration, distance }], waypoints: [{ hint, distance, name, location }] }`
- `GET /table/v1/driving/{coords}?sources=0&destinations=1;2&annotations=duration,distance` → `{ code, durations, distances, destinations, sources }` (`null` si injoignable)
- `GET /nearest/v1/driving/{lon},{lat}`
- Erreurs HTTP 400 comme OSRM : `InvalidUrl`, `InvalidValue`, `InvalidOptions`, `InvalidService`, `NoSegment`, `NoRoute`, `TooBig`.
- `GET /health` → `{"ok":true}` ; CORS `Access-Control-Allow-Origin: *`.

Construction du graphe : segments `road` des classes motorway, trunk, primary, secondary, tertiary,
unclassified, residential, living_street, service (bretelles = `subclass: link` / `is_link`), découpés à
chaque connecteur (`connectors[].at`) → 479 k nœuds, 556 k arêtes (Paris + Nice), géométrie conservée.
- **Sens uniques** : `access_restrictions` `{access_type: denied, when.heading: backward}` ⇒ sens de la géométrie
  uniquement (`forward` ⇒ sens inverse) ; règles évaluées au milieu de chaque arête (plages `between` respectées).
- **Accès** : `denied` sans condition ou pour `motor_vehicle`/`car` ⇒ arête exclue, sauf `allowed` explicite
  pour les véhicules (y compris `at_destination`) ; `access=private` (`allowed` + `recognized: as_private`) ⇒ exclue.
  Les restrictions conditionnelles (horaires `during`, gabarit `vehicle`) sont ignorées.
- **Vitesses** (km/h) : motorway 90, trunk 70, primary 40, secondary 35, tertiary 30, unclassified 30,
  residential 25, living_street 12, service 15, bretelles 45 — **plafonnées** par `speed_limits.max_speed`
  Overture quand renseignée (ex. périphérique 50). **Feux tricolores** (infrastructure `traffic_signals`, 18 831
  nœuds) : +10 s par feu franchi (`SIGNAL_PENALTY`).
- **Accrochage** : point le plus proche d'une arête (grille 0,004°), limité aux grandes composantes fortement
  connexes (évite les parkings/impasses privés isolés), rayon max 3 km (`MAX_SNAP_M`).
- **Recherche** : A* (heuristique distance orthodromique / vitesse max du graphe ⇒ admissible) ; `/table` en
  Dijkstra 1→n. Temps de réponse : 2–40 ms en ville, ≈ 150 ms pour une diagonale complète de la zone Paris.

## Géocodeur (API Adresse) — `geocoder.mjs`, port 5002

- `GET /search/?q=…&limit=5&autocomplete=1[&lat=…&lon=…][&type=housenumber|street|locality|municipality|poi][&postcode=][&citycode=]`
  → `FeatureCollection` BAN : `properties { label, score, housenumber?, id, name, postcode, citycode, x, y (Lambert-93), city, district?, context, type, importance, street?, category? }`.
  `q` doit faire 3 à 200 caractères (sinon 400, comme la BAN).
- `GET /reverse/?lat=…&lon=…[&type=street|municipality][&limit=]` → adresse la plus proche (+ `distance` en m).
- `GET /completion/?text=…&type=StreetAddress,PositionOfInterest&maximumResponses=6` → format Géoplateforme
  (`{status:"OK", results:[{country, x, y, fulltext, city, zipcode, street, kind, poiType?}]}`).
  Alias : `/geocodage/search`, `/geocodage/reverse`, `/geocodage/completion`.
- `GET /health` → `{"ok":true}` ; CORS `*`.

Données : 1 233 939 adresses BAN (clé d'interopérabilité → `citycode`, identifiant de voie, `id` BAN
`75108_1733_00012`), 56 049 voies (une par voie BAN, position = adresse la plus centrale), 336 communes
(+ arrondissements « Paris 8e Arrondissement », + « Paris » 75056), 1 506 quartiers/lieux-dits
(divisions Overture, type `locality`), ≈ 6 700 POI (`type: "poi"`, `category` : airport, station, metro, hotel,
museum, landmark, stadium, hospital, university, park, theatre, shopping, embassy, townhall…) : lieux notables
de `notable.json`, gares/stations de métro (OSM), hôpitaux/universités/stades/parcs nommés (OSM), et Overture
places filtrées (confiance ≥ 0,8–0,9, noms nettoyés, doublons supprimés).

Recherche : insensible aux accents/casse, tokens + préfixe sur le dernier mot (autocomplete), abréviations
(`av`/`ave`→avenue, `bd`/`boul`→boulevard, `pl`→place, `r`→rue, `st`/`ste`→saint/sainte, `fg`/`fbg`→faubourg,
`ch`, `imp`, `rte`, `qu`, `pte`, `aero`…), numéros (`12`, `12bis`, `12 bis`, en tête ou en fin), codes postaux,
tolérance d'une faute de frappe (Damerau-Levenshtein) sur les mots longs, alias (`cdg`/`roissy` → CDG et
terminaux, `orly` → aéroport d'Orly). Classement : correspondance des mots (exact > préfixe > approché),
couverture du nom, importance (population de la commune, nombre d'adresses de la voie, catégorie de POI),
bonus « nom exact / commence par », numéro trouvé (+) ou absent (−), proximité si `lat/lon`. Latence :
p50 ≈ 1 ms, p95 ≈ 26 ms (frappe caractère par caractère), pire cas ≈ 70 ms (« 12 a »).

## Exemples (valeurs réelles)

```
Gare de Lyon (2.3743,48.8443) → CDG T2 (2.571,49.0047) : 33,7 km, 35,6 min (Quai de Bercy, périphérique, A3, A1)
Opéra (2.3316,48.872) → Orly (2.3652,48.7262)          : 19,3 km, 31,1 min
Opéra → Centre Pompidou                                  :  2,9 km, 10,6 min
Aéroport Nice (7.2159,43.6653) → Place Masséna           :  8,3 km, 12,8 min

« gare de lyon »            → Gare de Lyon 75012 Paris [station]
« cdg »                     → Aéroport Paris-Charles de Gaulle (CDG) 95700 Roissy-en-France, puis T1, T2, T2A…
« orly »                    → Aéroport Paris-Orly (ORY) 94390 Orly, puis la commune d'Orly
« hotel plaza athenee »     → Hôtel Plaza Athénée 75008 Paris [hotel]
« 10 bd haussmann »         → 10 Boulevard Haussmann 75009 Paris
« rue du fbg st honore 55 » → 55 Rue du Faubourg Saint-Honoré 75008 Paris
« 75008 »                   → Paris 8e Arrondissement
« nice aeroport »           → Aéroport Nice Côte d'Azur (NCE) 06200 Nice
```

## Espace disque

| Chemin | Taille | Contenu |
|---|---|---|
| `.dev-geo/cache/overture` | ≈ 395 Mo | extraits Overture (GeoParquet zstd) |
| `.dev-geo/cache/footers` | ≈ 11 Mo | index des row groups (bbox) par fichier |
| `.dev-geo/layers` | ≈ 380 Mo | couches NDJSON intermédiaires (supprimables, régénérées par l'étape `tiles`) |
| `.dev-geo/graph.bin` + `.json` | ≈ 54 Mo | graphe routier |
| `.dev-geo/geocoder` | ≈ 39 Mo | index du géocodeur |
| `.dev-geo/venv` + `.dev-geo/node` | ≈ 415 Mo | dépendances Python / Node locales |
| `apps/web/public/dev-map/tiles` | ≈ 117 Mo | 4 969 tuiles MVT |
| `apps/web/public/dev-map/fonts` | ≈ 14 Mo | glyphes Noto Sans |

Mémoire (RSS) : routeur ≈ 170 Mo, géocodeur ≈ 240 Mo ; le build des tuiles monte à ≈ 3–4 Go (`--max-old-space-size=12000`).

## Limites connues

- **Dev uniquement** : pas de trafic, pas de restrictions de manœuvre (`prohibited_transitions` ignorées), pas de
  pénalités de virage (seulement feux tricolores), restrictions horaires ignorées ; `steps=true` produit des étapes
  simplifiées (départ / changement de nom de voie / arrivée), pas d'alternatives, services `match`/`trip`/`tile`
  non implémentés ; `hint` toujours vide.
- Les zones sont des rectangles : les routes qui en sortent sont coupées (un trajet qui sort de la zone peut être
  plus long que dans la réalité ou `NoRoute`). Paris ↔ Nice : `NoRoute`.
- Tuiles : pas de couches `boundary`, `housenumber`, `mountain_peak` ; bâtiments seulement dans les centres ;
  aux zooms 5–8, hors des deux zones, seules les grandes villes de France sont étiquetées (pas de fond de carte) ;
  requêtes de tuiles hors zones → 404 (sans conséquence pour MapLibre).
- Géocodeur : les données BAN via OpenAddresses ont quelques trous (ex. pas de n° 20 Promenade des Anglais à Nice
  → la voie est renvoyée, et le n° 20 existant à Saint-Maur passe devant sans `lat/lon`) ; les POI issus d'Overture
  places restent parfois bruités (doublons mal placés) ; positions des terminaux sans équivalent Overture
  (CDG 2C/2D, Orly 2/3/4, Nice T2) = coordonnées approximatives de `notable.json`.
- La vitesse max légale plafonne la vitesse de classe mais ne l'augmente jamais (profil « urbain » volontairement prudent).
