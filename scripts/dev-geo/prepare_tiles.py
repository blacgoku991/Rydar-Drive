#!/usr/bin/env python3
"""Convertit le cache Overture en couches au schéma OpenMapTiles (NDJSON GeoJSON).

Sortie : .dev-geo/layers/<couche>.ndjson — une Feature par ligne, avec en plus
les propriétés techniques `_minzoom` / `_maxzoom` (retirées à l'encodage des tuiles
par tiles.mjs). Les noms de couches / attributs suivent https://openmaptiles.org/schema/
pour qu'un même style fonctionne sur ces tuiles et sur OpenFreeMap.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely import ops

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from extract import BUILDING_REGIONS, CACHE, FRANCE, REGIONS, ROOT  # noqa: E402
from overture_rules import flag_values, is_link, oneway_flag  # noqa: E402

OUT = os.path.join(ROOT, ".dev-geo", "layers")
MARGIN = 0.02  # marge de découpe autour des zones (degrés)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# --------------------------------------------------------------------------------------
# Écriture
# --------------------------------------------------------------------------------------
class Layers:
    def __init__(self):
        self.items: dict[str, list] = defaultdict(list)

    def add(self, layer: str, geom, props: dict, minzoom: int, maxzoom: int = 15):
        if geom is None or shapely.is_empty(geom):
            return
        p = {k: v for k, v in props.items() if v is not None and v != ""}
        p["_minzoom"] = int(minzoom)
        if maxzoom < 15:
            p["_maxzoom"] = int(maxzoom)
        self.items[layer].append((geom, p))

    def write(self):
        os.makedirs(OUT, exist_ok=True)
        for f in os.listdir(OUT):
            if f.endswith(".ndjson"):
                os.remove(os.path.join(OUT, f))
        stats = {}
        for layer, items in self.items.items():
            geoms = np.array([g for g, _ in items], dtype=object)
            geoms = shapely.transform(geoms, lambda c: np.round(c, 6))
            gj = shapely.to_geojson(geoms)
            path = os.path.join(OUT, f"{layer}.ndjson")
            n = 0
            with open(path, "w") as fh:
                for (g, p), s in zip(items, gj):
                    if s is None or '"coordinates":[]' in s:
                        continue
                    fh.write('{"type":"Feature","properties":%s,"geometry":%s}\n' % (json.dumps(p, ensure_ascii=False), s))
                    n += 1
            stats[layer] = n
        log("couches écrites :", json.dumps(stats))
        json.dump(stats, open(os.path.join(OUT, "_stats.json"), "w"), indent=1)


# --------------------------------------------------------------------------------------
# Utilitaires
# --------------------------------------------------------------------------------------
def load(name: str, region: str, columns=None):
    return pq.read_table(os.path.join(CACHE, f"{name}__{region}.parquet"), columns=columns)


def geoms(tbl, bbox):
    g = shapely.from_wkb(tbl.column("geometry").to_numpy(zero_copy_only=False))
    return shapely.clip_by_rect(g, bbox[0] - MARGIN, bbox[1] - MARGIN, bbox[2] + MARGIN, bbox[3] + MARGIN)


def area_km2(g):
    a = shapely.area(g)
    bb = shapely.bounds(g)  # NaN pour les géométries vides
    lat = (bb[..., 1] + bb[..., 3]) / 2
    return a * 111.32 * 111.32 * np.cos(np.radians(np.nan_to_num(lat, nan=45.0)))


def names_of(tbl):
    return [(n or {}).get("primary") for n in tbl.column("names").to_pylist()]


def name_props(name):
    if not name:
        return {}
    return {"name": name, "name_en": name, "name:latin": name}


def is_poly(t):
    return t in (3, 6)


def is_line(t):
    return t in (1, 5)


def fr_name(names: dict | None) -> str | None:
    if not names:
        return None
    common = dict(names.get("common") or [])
    return common.get("fr") or names.get("primary")


# --------------------------------------------------------------------------------------
# water / waterway / water_name
# --------------------------------------------------------------------------------------
def do_water(L: Layers, region: str):
    t = load("water", region)
    g = geoms(t, REGIONS[region])
    types = shapely.get_type_id(g)
    areas = area_km2(g)
    sub, cls = t.column("subtype").to_pylist(), t.column("class").to_pylist()
    nm = names_of(t)
    tags = t.column("source_tags").to_pylist()
    inter = t.column("is_intermittent").to_pylist()
    for i in range(t.num_rows):
        if shapely.is_empty(g[i]):
            continue
        st, c, tg, a = sub[i], cls[i], dict(tags[i] or []), float(areas[i])
        if is_poly(types[i]):
            if st == "physical":  # baies, caps… → étiquettes seulement
                if c == "bay" and nm[i]:
                    L.add("water_name", shapely.point_on_surface(g[i]), {"class": "bay", **name_props(nm[i])}, 11)
                continue
            if st == "ocean":
                k = "ocean"
            elif st in ("river", "canal") or tg.get("water") in ("river", "canal", "oxbow", "lock", "stream"):
                k = "river"
            elif c == "swimming_pool":
                k = "swimming_pool"
            elif st == "pond" or c in ("reflecting_pool", "fishpond", "pond"):
                k = "pond"
            else:
                k = "lake"
            if k == "ocean":
                mz = 0
            elif k == "river":
                mz = 5 if a > 1 else 8 if a > 0.1 else 10 if a > 0.01 else 12
            elif k == "swimming_pool":
                mz = 14
            else:
                mz = 6 if a > 5 else 8 if a > 1 else 10 if a > 0.1 else 12 if a > 0.01 else 13
            p = {"class": k, "intermittent": 1 if inter[i] else 0}
            if tg.get("tunnel") or tg.get("covered") == "yes":
                p["brunnel"] = "tunnel"
            L.add("water", g[i], p, mz)
            if nm[i] and k == "lake" and a > 0.05:
                L.add("water_name", shapely.point_on_surface(g[i]), {"class": "lake", **name_props(nm[i])}, 12 if a > 0.5 else 14)
        elif is_line(types[i]):
            k = c if c in ("river", "canal", "stream", "ditch", "drain") else st
            if k not in ("river", "canal", "stream", "ditch", "drain"):
                continue
            mz = {"river": 8, "canal": 10, "stream": 12}.get(k, 14)
            p = {"class": k, "intermittent": 1 if inter[i] else 0, **name_props(nm[i])}
            if tg.get("tunnel"):
                p["brunnel"] = "tunnel"
            elif tg.get("bridge"):
                p["brunnel"] = "bridge"
            L.add("waterway", g[i], p, mz)
        elif types[i] == 0 and st == "physical" and c == "bay" and nm[i]:
            L.add("water_name", g[i], {"class": "bay", **name_props(nm[i])}, 12)
    if region == "nice":  # étiquette de la mer (point de placement choisi à la main)
        L.add("water_name", shapely.Point(7.245, 43.655), {"class": "sea", **name_props("Mer Méditerranée")}, 9)


# --------------------------------------------------------------------------------------
# landcover / landuse / park  (+ poi « parcs » via park points)
# --------------------------------------------------------------------------------------
LAND_COVER = {  # base/land (natural=*) → (class, subclass)
    ("forest", None): ("wood", "forest"),
    ("shrub", "scrub"): ("grass", "scrub"),
    ("shrub", "shrubbery"): ("grass", "scrub"),
    ("shrub", "heath"): ("grass", "heath"),
    ("grass", None): ("grass", "grassland"),
    ("wetland", None): ("wetland", "wetland"),
    ("sand", "beach"): ("sand", "beach"),
    ("sand", None): ("sand", "sand"),
    ("rock", None): ("rock", "bare_rock"),
}
LU_COVER = {  # base/land_use class → landcover (class, subclass)
    "grass": ("grass", "grass"), "meadow": ("grass", "meadow"), "farmland": ("farmland", "farmland"),
    "garden": ("grass", "garden"), "flowerbed": ("grass", "garden"), "allotments": ("farmland", "allotments"),
    "orchard": ("farmland", "orchard"), "vineyard": ("farmland", "vineyard"), "plant_nursery": ("farmland", "plant_nursery"),
    "golf_course": ("grass", "golf_course"), "village_green": ("grass", "village_green"),
    "recreation_ground": ("grass", "recreation_ground"), "fairway": ("grass", "golf_course"), "green": ("grass", "golf_course"),
    "bunker": ("sand", "sand"), "farmyard": ("farmland", "farm"),
}
LU_USE = {  # base/land_use class → landuse class
    "residential": "residential", "industrial": "industrial", "works": "industrial", "commercial": "commercial",
    "retail": "retail", "cemetery": "cemetery", "grave_yard": "cemetery", "hospital": "hospital", "clinic": "hospital",
    "school": "school", "schoolyard": "school", "kindergarten": "kindergarten", "college": "college", "university": "university",
    "stadium": "stadium", "pitch": "pitch", "playground": "playground", "track": "track", "railway": "railway",
    "military": "military", "barracks": "military", "zoo": "zoo", "theme_park": "theme_park", "quarry": "quarry",
    "garages": "garages", "library": "library",
}


def area_zoom(a: float, big=6) -> int:
    return big if a > 5 else 8 if a > 1 else 10 if a > 0.1 else 12 if a > 0.01 else 13 if a > 0.002 else 14


def do_land(L: Layers, region: str):
    t = load("land", region)
    g = geoms(t, REGIONS[region])
    types = shapely.get_type_id(g)
    areas = area_km2(g)
    sub, cls = t.column("subtype").to_pylist(), t.column("class").to_pylist()
    for i in range(t.num_rows):
        if not is_poly(types[i]) or shapely.is_empty(g[i]):
            continue
        m = LAND_COVER.get((sub[i], cls[i])) or LAND_COVER.get((sub[i], None))
        if not m:
            continue
        a = float(areas[i])
        L.add("landcover", g[i], {"class": m[0], "subclass": m[1] if m[1] != "forest" else cls[i]}, area_zoom(a, 7))


def do_land_use(L: Layers, region: str):
    t = load("land_use", region)
    g = geoms(t, REGIONS[region])
    types = shapely.get_type_id(g)
    areas = area_km2(g)
    sub, cls = t.column("subtype").to_pylist(), t.column("class").to_pylist()
    nm = names_of(t)
    for i in range(t.num_rows):
        if not is_poly(types[i]) or shapely.is_empty(g[i]):
            continue
        st, c, a = sub[i], cls[i], float(areas[i])
        if (st == "park" and c in ("park", "dog_park")) or st == "protected":
            k = "park" if st == "park" else ("nature_reserve" if c == "nature_reserve" else "protected_area")
            if c == "dog_park" and a < 0.01:
                continue
            L.add("park", g[i], {"class": k, **name_props(nm[i])}, area_zoom(a, 6))
            # l'herbe du parc pour le rendu (comme OSM leisure=park → landcover grass/park)
            L.add("landcover", g[i], {"class": "grass", "subclass": "park"}, area_zoom(a, 7))
            if nm[i] and a > 0.005:
                rank = 1 if a > 1 else 2 if a > 0.2 else 3 if a > 0.05 else 5
                L.add("park", shapely.point_on_surface(g[i]), {"class": k, "rank": rank, **name_props(nm[i])},
                      11 if a > 1 else 13 if a > 0.1 else 14 if a > 0.02 else 15)
            continue
        if c in LU_COVER:
            m = LU_COVER[c]
            L.add("landcover", g[i], {"class": m[0], "subclass": m[1]}, area_zoom(a, 7))
            continue
        if c in LU_USE:
            k = LU_USE[c]
            mz = area_zoom(a, 9)
            if k == "residential":
                mz = max(mz, 10)
            L.add("landuse", g[i], {"class": k}, mz)


# --------------------------------------------------------------------------------------
# transportation / transportation_name
# --------------------------------------------------------------------------------------
ROAD_OMT = {
    "motorway": "motorway", "trunk": "trunk", "primary": "primary", "secondary": "secondary", "tertiary": "tertiary",
    "residential": "minor", "unclassified": "minor", "living_street": "minor", "unknown": "minor",
    "service": "service", "track": "track",
    "footway": "path", "path": "path", "steps": "path", "cycleway": "path", "pedestrian": "path", "bridleway": "path",
}
ROAD_Z = {"motorway": 5, "trunk": 5, "primary": 7, "secondary": 10, "tertiary": 10, "minor": 13, "service": 13, "track": 14, "path": 14}
LINK_Z = {"motorway": 9, "trunk": 10, "primary": 11, "secondary": 12, "tertiary": 12}
NAME_Z = {"motorway": 8, "trunk": 9, "primary": 11, "secondary": 12, "tertiary": 13, "minor": 14, "service": 15, "track": 15, "path": 15}
RAIL_OMT = {  # classe Overture rail → (class, subclass, minzoom)
    "standard_gauge": ("rail", "rail", 10), "narrow_gauge": ("rail", "narrow_gauge", 12), "funicular": ("rail", "funicular", 13),
    "subway": ("transit", "subway", 12), "light_rail": ("transit", "light_rail", 12), "tram": ("transit", "tram", 12),
    "monorail": ("transit", "monorail", 13),
}
REF_PRIO = {"A": 0, "N": 1, "RN": 1, "M": 2, "D": 3, "RD": 3, "E": 5}


def pick_ref(routes) -> str | None:
    refs = [r.get("ref") for r in routes or [] if r.get("ref")]
    if not refs:
        return None
    refs = sorted(set(refs), key=lambda r: (REF_PRIO.get(r.split(" ")[0], 4), len(r)))
    return refs[0]


def brunnel_pieces(geom, flags):
    """Découpe une ligne selon les plages is_bridge / is_tunnel → [(sous-ligne, brunnel|None)]."""
    ranges = []
    for name, val in (("is_bridge", "bridge"), ("is_tunnel", "tunnel")):
        for a, b in flag_values(flags, name) or []:
            ranges.append((a, b, val))
    if not ranges:
        return [(geom, None)]
    if any(a <= 1e-6 and b >= 1 - 1e-6 for a, b, _ in ranges):
        full = next(v for a, b, v in ranges if a <= 1e-6 and b >= 1 - 1e-6)
        return [(geom, full)]
    cuts = sorted({0.0, 1.0, *[r[0] for r in ranges], *[r[1] for r in ranges]})
    out = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 1e-6:
            continue
        mid = (a + b) / 2
        br = next((v for s, e, v in ranges if s <= mid <= e), None)
        out.append((ops.substring(geom, a, b, normalized=True), br))
    return out


def do_transportation(L: Layers, region: str):
    t = load("segment", region, ["subtype", "class", "subclass", "names", "road_flags", "rail_flags",
                                 "access_restrictions", "routes", "geometry"])
    g = geoms(t, REGIONS[region])
    raw = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
    sub = t.column("subtype").to_pylist()
    cls = t.column("class").to_pylist()
    subcls = t.column("subclass").to_pylist()
    nm = names_of(t)
    rflags = t.column("road_flags").to_pylist()
    railf = t.column("rail_flags").to_pylist()
    access = t.column("access_restrictions").to_pylist()
    routes = t.column("routes").to_pylist()
    groups: dict[tuple, list] = defaultdict(list)
    for i in range(t.num_rows):
        if shapely.is_empty(g[i]):
            continue
        if sub[i] == "road":
            k = ROAD_OMT.get(cls[i])
            if not k:
                continue
            vals = {v for f in rflags[i] or [] if not f.get("between") for v in f.get("values") or []}
            if "is_under_construction" in vals or ("is_indoor" in vals and k == "path"):
                continue
            link = k in LINK_Z and is_link(subcls[i], rflags[i])
            p = {"class": k}
            if k == "path":
                p["subclass"] = cls[i]
                mz = 15 if subcls[i] in ("sidewalk", "crosswalk", "cycle_crossing") else 14
            elif k == "service":
                if subcls[i] in ("driveway", "parking_aisle", "alley"):
                    p["service"] = subcls[i]
                mz = 14 if subcls[i] in ("driveway", "parking_aisle") else 13
            else:
                mz = LINK_Z[k] if link else ROAD_Z[k]
            if link:
                p["ramp"] = 1
            ow = oneway_flag(access[i]) if k not in ("path",) else 0
            if ow:
                p["oneway"] = ow
            for piece, br in brunnel_pieces(g[i], rflags[i]):
                q = dict(p)
                if br:
                    q["brunnel"] = br
                L.add("transportation", piece, q, mz)
            ref = pick_ref(routes[i]) if k in ("motorway", "trunk", "primary", "secondary", "tertiary") else None
            if nm[i] or ref:
                groups[(nm[i], k, ref, p.get("subclass"))].append(raw[i])
        elif sub[i] == "rail":
            m = RAIL_OMT.get(cls[i])
            if not m:
                continue
            vals = {v for f in railf[i] or [] for v in f.get("values") or []}
            if vals & {"is_disused", "is_abandoned", "is_under_construction"}:
                continue
            p = {"class": m[0], "subclass": m[1]}
            for piece, br in brunnel_pieces(g[i], railf[i]):
                q = dict(p)
                if br:
                    q["brunnel"] = br
                L.add("transportation", piece, q, m[2])
    # Noms : fusion des segments contigus de même (nom, classe, ref) pour un bon placement des étiquettes
    b = REGIONS[region]
    for (name, k, ref, subclass), lines in groups.items():
        merged = shapely.line_merge(shapely.MultiLineString(lines)) if len(lines) > 1 else lines[0]
        parts = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
        for part in parts:
            part = shapely.clip_by_rect(part, b[0] - MARGIN, b[1] - MARGIN, b[2] + MARGIN, b[3] + MARGIN)
            p = {"class": k, "subclass": subclass, **name_props(name)}
            if ref:
                p.update({"ref": ref, "ref_length": len(ref), "network": "road"})
            L.add("transportation_name", part, p, NAME_Z[k] if name else min(NAME_Z[k], 10))


# --------------------------------------------------------------------------------------
# building
# --------------------------------------------------------------------------------------
def do_buildings(L: Layers, region: str):
    t = load("building", region)
    g = geoms(t, BUILDING_REGIONS[region])
    types = shapely.get_type_id(g)
    h = t.column("height").to_pylist()
    mh = t.column("min_height").to_pylist()
    fl = t.column("num_floors").to_pylist()
    ug = t.column("is_underground").to_pylist()
    for i in range(t.num_rows):
        if ug[i] or not is_poly(types[i]) or shapely.is_empty(g[i]):
            continue
        height = h[i] if h[i] else (fl[i] * 3.2 if fl[i] else 10.0)
        L.add("building", g[i], {"render_height": round(max(3.0, height), 1),
                                 "render_min_height": round(mh[i] or 0.0, 1)}, 14)


# --------------------------------------------------------------------------------------
# place (communes, arrondissements, quartiers)
# --------------------------------------------------------------------------------------
def place_rank(k: str, pop: int) -> int:
    if k == "city":
        return 1 if pop > 1_000_000 else 2 if pop > 300_000 else 3 if pop > 100_000 else 4
    if k == "town":
        return 5 if pop > 50_000 else 6 if pop > 20_000 else 7
    if k == "village":
        return 8 if pop > 5_000 else 9
    return {"suburb": 11, "quarter": 12, "neighbourhood": 13, "hamlet": 14}.get(k, 15)


def do_places(L: Layers, region: str, seen: set):
    t = load("division", region, ["id", "names", "subtype", "class", "local_type", "population", "geometry"])
    g = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
    for i, r in enumerate(t.select(["id", "names", "subtype", "class", "local_type", "population"]).to_pylist()):
        if shapely.get_type_id(g[i]) != 0 or r["id"] in seen:
            continue
        name = fr_name(r["names"])
        if not name:
            continue
        pop = r["population"] or 0
        lt = dict(r["local_type"] or []).get("en")
        st = r["subtype"]
        if st == "locality":
            k = r["class"] if r["class"] in ("city", "town", "village", "hamlet") else "village"
            if k == "city":
                mz = 5 if pop > 1_000_000 else 7 if pop > 200_000 else 8
            elif k == "town":
                mz = 9 if pop > 50_000 else 10 if pop > 20_000 else 11
            elif k == "village":
                mz = 12
            else:
                mz = 14
        elif st == "macrohood":
            k, mz = "suburb", 12
        elif st == "neighborhood":
            k = "quarter" if lt == "quarter" else "suburb" if lt == "suburb" else "neighbourhood"
            mz = 13 if k != "neighbourhood" else 14
        elif st == "microhood" and lt == "quarter":
            k, mz = "neighbourhood", 15
        else:
            continue
        seen.add(r["id"])
        p = {"class": k, "rank": place_rank(k, pop), **name_props(name)}
        if name == "Paris" and k == "city":
            p["capital"] = 2
        L.add("place", g[i], p, mz)


def do_france_cities(L: Layers, seen: set):
    """Grandes villes de France (≥ 100 000 hab.) pour le contexte aux zooms 5–8."""
    t = load("division", "france", ["id", "names", "subtype", "class", "population", "country", "geometry"])
    g = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
    for i, r in enumerate(t.select(["id", "names", "subtype", "class", "population", "country"]).to_pylist()):
        if r["subtype"] != "locality" or r["country"] != "FR" or r["id"] in seen or shapely.get_type_id(g[i]) != 0:
            continue
        pop = r["population"] or 0
        if pop < 100_000:
            continue
        name = fr_name(r["names"])
        mz = 5 if pop > 400_000 else 6 if pop > 200_000 else 7
        L.add("place", g[i], {"class": "city", "rank": place_rank("city", pop), **name_props(name)}, mz, 8)


# --------------------------------------------------------------------------------------
# aeroway / aerodrome_label / poi
# --------------------------------------------------------------------------------------
AERO = {"airport": "aerodrome", "international_airport": "aerodrome", "military_airport": "aerodrome",
        "airstrip": "aerodrome", "heliport": "heliport", "runway": "runway", "taxiway": "taxiway",
        "taxilane": "taxiway", "apron": "apron", "helipad": "helipad"}
AERO_Z = {"aerodrome": 10, "heliport": 13, "runway": 10, "taxiway": 13, "apron": 12, "helipad": 14}


MAJOR_STATIONS = {"Gare de Lyon", "Gare du Nord", "Gare de l'Est", "Paris-Saint-Lazare", "Paris Saint-Lazare", "Gare Montparnasse",
                  "Gare d'Austerlitz", "Gare de Bercy", "Nice-Ville", "Nice Ville", "La Défense", "Massy TGV",
                  "Aéroport Charles de Gaulle 2 TGV", "Versailles Chantiers", "Paris Gare du Nord"}


def do_infra(L: Layers, region: str):
    t = load("infrastructure", region, ["names", "subtype", "class", "source_tags", "geometry"])
    g = geoms(t, REGIONS[region])
    types = shapely.get_type_id(g)
    areas = area_km2(g)
    for i, r in enumerate(t.select(["names", "subtype", "class", "source_tags"]).to_pylist()):
        if shapely.is_empty(g[i]):
            continue
        st, c = r["subtype"], r["class"]
        name = (r["names"] or {}).get("primary")
        tags = dict(r["source_tags"] or [])
        if st == "airport" and c in AERO:
            k = AERO[c]
            if k == "aerodrome" and not is_poly(types[i]):
                continue
            mz = AERO_Z[k]
            if k == "aerodrome":
                a = float(areas[i])
                mz = 8 if a > 5 else 10 if a > 0.5 else 12
            p = {"class": k}
            if k == "runway" and tags.get("ref"):
                p["ref"] = tags["ref"]
            L.add("aeroway", g[i], p, mz)
            if k == "aerodrome" and name:
                kind = ("international" if c == "international_airport" or tags.get("aerodrome") == "international"
                        else "military" if c == "military_airport" else "public" if tags.get("iata") else "other")
                p = {"class": kind, **name_props(name), "iata": tags.get("iata"), "icao": tags.get("icao")}
                if tags.get("ele", "").replace(".", "").isdigit():
                    p["ele"] = int(float(tags["ele"]))
                L.add("aerodrome_label", shapely.point_on_surface(g[i]), p, 8 if kind == "international" else 10 if tags.get("iata") else 12)
        elif st == "transit" and c in ("railway_station", "subway_station") and name and types[i] == 0:
            if c == "railway_station":
                major = name in MAJOR_STATIONS
                L.add("poi", g[i], {"class": "railway", "subclass": "station", "rank": 1 if major else 10, **name_props(name)},
                      12 if major else 14)
            else:
                L.add("poi", g[i], {"class": "railway", "subclass": "subway", "rank": 20, **name_props(name)}, 15)


POI_CLASS = {"airport": ("aerodrome", "aerodrome"), "landmark": ("attraction", "attraction"), "museum": ("museum", "museum"),
             "stadium": ("stadium", "stadium"), "convention_centre": ("attraction", "convention_centre"),
             "shopping": ("shop", "mall"), "hotel": ("lodging", "hotel")}


def do_notable_pois(L: Layers):
    data = json.load(open(os.path.join(HERE, "notable.json")))["places"]
    for p in data:
        if p.get("category") == "airport":
            continue  # aéroports : déjà dans aerodrome_label (OSM)
        c, s = POI_CLASS.get(p["category"], ("attraction", p["category"]))
        L.add("poi", shapely.Point(p["lon"], p["lat"]), {"class": c, "subclass": s, "rank": p.get("rank", 3),
                                                        **name_props(p["name"])}, 12 if p.get("rank", 3) == 1 else 13)


def do_landuse_pois(L: Layers, region: str):
    """Hôpitaux / universités / stades nommés (polygones OSM) → poi au centre."""
    t = load("land_use", region, ["names", "subtype", "class", "geometry"])
    g = geoms(t, REGIONS[region])
    areas = area_km2(g)
    for i, r in enumerate(t.select(["names", "subtype", "class"]).to_pylist()):
        name = (r["names"] or {}).get("primary")
        if not name or shapely.is_empty(g[i]) or not is_poly(shapely.get_type_id(g[i])):
            continue
        m = {"hospital": ("hospital", "hospital"), "university": ("college", "university"), "stadium": ("stadium", "stadium")}.get(r["class"])
        if not m or areas[i] < 0.005:
            continue
        L.add("poi", shapely.point_on_surface(g[i]), {"class": m[0], "subclass": m[1], "rank": 8, **name_props(name)}, 15 if m[0] == "college" else 14)


def main():
    t0 = time.time()
    L = Layers()
    seen_div: set = set()
    for region in REGIONS:
        log(f"[{region}] eau…")
        do_water(L, region)
        log(f"[{region}] occupation du sol…")
        do_land(L, region)
        do_land_use(L, region)
        do_landuse_pois(L, region)
        log(f"[{region}] routes…")
        do_transportation(L, region)
        log(f"[{region}] bâtiments…")
        do_buildings(L, region)
        log(f"[{region}] lieux, aéroports, gares…")
        do_places(L, region, seen_div)
        do_infra(L, region)
    do_france_cities(L, seen_div)
    do_notable_pois(L)
    log("écriture…")
    L.write()
    log(f"terminé en {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
