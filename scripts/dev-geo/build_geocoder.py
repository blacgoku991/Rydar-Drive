#!/usr/bin/env python3
"""Construit l'index du géocodeur de dev (compatible API Adresse / BAN) depuis Overture.

Sources (cache .dev-geo/cache/overture) :
- addresses  : adresses françaises issues de la BAN (via OpenAddresses) ; record_id = clé
               d'interopérabilité BAN « 75108_1733_00012_bis » → citycode, voie, numéro.
- divisions  : communes (population, point), arrondissements et quartiers de Paris/Nice.
- places     : POI Overture filtrés (hôtels, musées, monuments, stades, hôpitaux…), noms nettoyés.
- infrastructure : gares ferroviaires et stations de métro (données OSM, noms propres).
- land_use   : hôpitaux, universités, stades, parcs, cimetières nommés (OSM).
- notable.json : aéroports / terminaux / grands sites, avec alias (« cdg », « roissy »…).

Sortie : .dev-geo/geocoder/docs.json (voies, communes, lieux-dits, POI) +
         .dev-geo/geocoder/addr.bin (coordonnées + code postal de chaque adresse, triées par voie).
La tokenisation / normalisation est faite au démarrage par geocoder.mjs (une seule implémentation).
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict

import numpy as np
import pyarrow.parquet as pq
import shapely
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from extract import CACHE, REGIONS, ROOT  # noqa: E402

OUT = os.path.join(ROOT, ".dev-geo", "geocoder")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", " ", s.replace("œ", "oe").replace("æ", "ae")).strip()


def proj(lon, lat):
    lon, lat = np.asarray(lon, float), np.asarray(lat, float)
    return np.column_stack([lon * 111320 * math.cos(math.radians(46.5)), lat * 110540])


def arr_name(n: int) -> str:
    return f"Paris {n}{'er' if n == 1 else 'e'} Arrondissement"


NUM_RE = re.compile(r"^\s*(\d+)\s*([a-zA-Z]*)\s*$")


def fmt_number(num: str) -> tuple[str, int, str] | None:
    """'10ter' → ('10 ter', 10, 'ter') ; '12B' → ('12 B', 12, 'b')."""
    m = NUM_RE.match(num or "")
    if not m:
        return None
    n, suf = int(m.group(1)), m.group(2).lower()
    if not suf:
        return str(n), n, ""
    disp = f"{n} {suf}" if len(suf) > 1 else f"{n} {suf.upper()}"
    return disp, n, suf


# --------------------------------------------------------------------------------------
def load_addresses():
    streets: dict[tuple, dict] = {}
    for region in REGIONS:
        t = pq.read_table(os.path.join(CACHE, f"address__{region}.parquet"),
                          columns=["street", "number", "postcode", "address_levels", "country", "sources", "geometry"])
        xy = shapely.get_coordinates(shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False)))
        streets_col = t.column("street").to_pylist()
        numbers = t.column("number").to_pylist()
        pcs = t.column("postcode").to_pylist()
        levels = t.column("address_levels").to_pylist()
        countries = t.column("country").to_pylist()
        sources = t.column("sources").to_pylist()
        for i in range(t.num_rows):
            if countries[i] != "FR" or not streets_col[i] or not numbers[i]:
                continue
            rid = ((sources[i] or [{}])[0] or {}).get("record_id") or ""
            m = re.match(r"^(\d[0-9AB]\d{3})_([0-9a-zA-Z]{4})_", rid)
            city = (levels[i] or [{}])[0].get("value") if levels[i] else None
            if not m or not city:
                continue
            fn = fmt_number(numbers[i])
            if not fn:
                continue
            citycode, voie = m.group(1), m.group(2).lower()
            key = (citycode, voie)
            s = streets.get(key)
            if s is None:
                s = streets[key] = {"citycode": citycode, "voie": voie, "names": Counter(), "city": city, "addr": {}}
            s["names"][streets_col[i]] += 1
            k = (fn[1], fn[2])
            if k not in s["addr"]:
                s["addr"][k] = (fn[0], float(xy[i, 0]), float(xy[i, 1]), pcs[i] or "")
    return streets


def load_divisions():
    out = []
    for region in REGIONS:
        t = pq.read_table(os.path.join(CACHE, f"division__{region}.parquet"),
                          columns=["id", "names", "subtype", "class", "local_type", "population", "geometry"])
        g = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
        for i, r in enumerate(t.select(["id", "names", "subtype", "class", "local_type", "population"]).to_pylist()):
            if shapely.get_type_id(g[i]) != 0 or not r["names"]:
                continue
            common = dict(r["names"].get("common") or [])
            name = common.get("fr") or r["names"].get("primary")
            out.append({"name": name, "subtype": r["subtype"], "class": r["class"], "pop": r["population"] or 0,
                        "lt": dict(r["local_type"] or []).get("en"), "lon": g[i].x, "lat": g[i].y})
    return out


DEPTS = {
    "75": ("Paris", "Île-de-France"), "77": ("Seine-et-Marne", "Île-de-France"), "78": ("Yvelines", "Île-de-France"),
    "91": ("Essonne", "Île-de-France"), "92": ("Hauts-de-Seine", "Île-de-France"), "93": ("Seine-Saint-Denis", "Île-de-France"),
    "94": ("Val-de-Marne", "Île-de-France"), "95": ("Val-d'Oise", "Île-de-France"), "60": ("Oise", "Hauts-de-France"),
    "06": ("Alpes-Maritimes", "Provence-Alpes-Côte d'Azur"),
}


def context(citycode: str) -> str:
    d = citycode[:2]
    dn, rn = DEPTS.get(d, ("", ""))
    return ", ".join(x for x in (d, dn, rn) if x)


# --------------------------------------------------------------------------------------
PLACE_CATS = {  # taxonomy.primary Overture → (catégorie, confiance mini, importance)
    "hotel": ("hotel", 0.9, 0.42), "museum": ("museum", 0.8, 0.55), "monument": ("landmark", 0.85, 0.52),
    "palace": ("landmark", 0.85, 0.55), "castle": ("landmark", 0.85, 0.5), "historic_site": ("landmark", 0.95, 0.45),
    "stadium_arena": ("stadium", 0.9, 0.45), "hospital": ("hospital", 0.85, 0.5), "college_university": ("university", 0.9, 0.42),
    "shopping_mall": ("shopping", 0.9, 0.45), "department_store": ("shopping", 0.9, 0.42), "opera_and_ballet": ("theatre", 0.85, 0.5),
    "theatre_venue": ("theatre", 0.9, 0.45), "performing_arts_venue": ("theatre", 0.9, 0.42), "amusement_park": ("attraction", 0.9, 0.45),
    "zoo": ("attraction", 0.85, 0.5), "aquarium": ("attraction", 0.85, 0.5), "embassy": ("embassy", 0.9, 0.45),
    "town_hall": ("townhall", 0.9, 0.45), "casino": ("casino", 0.9, 0.42), "event_venue": ("venue", 0.9, 0.4),
    "movie_theater": ("cinema", 0.9, 0.38),
}
NON_LATIN = re.compile(r"[^\u0000-ɏḀ-ỿ‘-‟–—«»°…]")
SUFFIX = re.compile(r"\s*(?:[,\-–—|(]\s*)(?:paris|nice|france|ile[- ]de[- ]france|idf)(?:\s*\d{1,2}\s*(?:e|er|eme|ème)?)?\)?\s*$", re.I)


STREETLIKE = re.compile(r"(?i)^(parking|rue|avenue|av\.?|boulevard|bd|place|quai|allée|impasse|chemin|route|square)\b")


def clean_name(n: str | None) -> str | None:
    if not n:
        return None
    n = re.sub(r"\s+", " ", n).strip(" -,|")
    if NON_LATIN.search(n) or "@" in n or "http" in n.lower() or "www." in n.lower():
        return None
    prev = None
    while prev != n:
        prev = n
        n = SUFFIX.sub("", n).strip(" -,|")
        n = re.sub(r"(?i)\s*,\s*paris\s*,?\s*france$", "", n).strip()
    n = re.sub(r"(?<=\s)(De|Du|Des)(?=\s)", lambda m: m.group(1).lower(), n)
    n = re.sub(r"(?<=\s)D'(?=\w)", "d'", n)
    if len(n) < 3 or len(n) > 70 or n.isupper() and len(n) > 12:
        return None
    return n


def station_display(name: str, tags: dict | None = None) -> str:
    """« Gare de X » pour les gares SNCF, « X (RER) » pour les gares RER/RATP."""
    if re.match(r"(?i)^gare\b", name):
        return name
    m = re.match(r"^Paris[- ](.+)$", name)
    if m:  # « Paris-Saint-Lazare » → « Gare Saint-Lazare » ; « Paris Gare du Nord » → « Gare du Nord »
        rest = m.group(1)
        return rest if re.match(r"(?i)^gare\b", rest) else "Gare " + rest
    tags = tags or {}
    net, op = tags.get("network", ""), tags.get("operator", "")
    sncf = re.search(r"TGV|TER|Transilien|Intercit|SNCF|Ouigo", net) or ("SNCF" in op and "RER" not in net)
    if not sncf and re.search(r"RER|RATP", net + " " + op):
        return f"{name} (RER)"
    if re.match(r"(?i)^les\s", name):
        return "Gare des " + name[4:]
    if re.match(r"(?i)^le\s", name):
        return "Gare du " + name[3:]
    if re.match(r"(?i)^[aeiouyhéèêâîôû]", name):
        return "Gare d'" + name
    return "Gare de " + name


def main():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    streets = load_addresses()
    log(f"{len(streets)} voies, {sum(len(s['addr']) for s in streets.values())} adresses")
    divisions = load_divisions()

    # ---- communes (citycode) ---------------------------------------------------------
    muni: dict[str, dict] = {}
    for s in streets.values():
        m = muni.setdefault(s["citycode"], {"names": Counter(), "pcs": Counter(), "xs": [], "ys": [], "n": 0})
        m["names"][s["city"]] += len(s["addr"])
        for disp, x, y, pc in s["addr"].values():
            m["pcs"][pc] += 1
            m["n"] += 1
            if m["n"] % 7 == 0 or m["n"] < 50:
                m["xs"].append(x)
                m["ys"].append(y)
    div_by_name = defaultdict(list)
    for d in divisions:
        div_by_name[norm(d["name"])].append(d)

    docs = []
    addr_lon, addr_lat, addr_pc, numbers = [], [], [], []
    pc_table: dict[str, int] = {}
    muni_info = {}
    for code, m in muni.items():
        city = m["names"].most_common(1)[0][0]
        cx, cy = float(np.mean(m["xs"])), float(np.mean(m["ys"]))
        pc = m["pcs"].most_common(1)[0][0]
        if code.startswith("751"):
            n = int(code[3:])
            name, pop_name, city = arr_name(n), arr_name(n), "Paris"
        else:
            name = pop_name = city
        cands = [d for d in div_by_name.get(norm(pop_name), []) if d["subtype"] in ("locality", "macrohood", "localadmin")]
        cands = [d for d in cands if abs(d["lon"] - cx) < 0.08 and abs(d["lat"] - cy) < 0.06]
        pop = max((d["pop"] for d in cands), default=0)
        if not pop and code.startswith("751"):
            pop = 100_000  # population moyenne d'un arrondissement (absente d'Overture pour la plupart)
        pt = next((d for d in sorted(cands, key=lambda d: -d["pop"]) if d["subtype"] in ("locality", "macrohood")), None)
        lon, lat = (pt["lon"], pt["lat"]) if pt else (cx, cy)
        imp = 0.35 + 0.55 * min(1.0, math.log10(max(pop, 1000)) / 6.3) if pop else 0.4
        muni_info[code] = {"city": city, "pop": pop, "postcode": pc}
        docs.append({"t": "municipality", "name": name, "pc": pc, "cc": code, "city": city, "lon": lon, "lat": lat,
                     "imp": round(imp, 4), "id": code,
                     "alias": sorted(p for p in m["pcs"] if p) + ([f"paris {int(code[3:])}e", f"paris {int(code[3:])}", f"{int(code[3:])}e arrondissement"]
                                                                   if code.startswith("751") else [])})
    # Paris (commune « chapeau ») : 75056
    paris = next((d for d in div_by_name.get("paris", []) if d["subtype"] == "locality"), None)
    if paris:
        docs.append({"t": "municipality", "name": "Paris", "pc": "75001", "cc": "75056", "city": "Paris", "lon": paris["lon"],
                     "lat": paris["lat"], "imp": 0.99, "id": "75056", "alias": []})
        muni_info["75056"] = {"city": "Paris", "pop": paris["pop"], "postcode": "75001"}

    # ---- voies + adresses ------------------------------------------------------------------
    for (code, voie), s in sorted(streets.items()):
        name = s["names"].most_common(1)[0][0]
        items = sorted(s["addr"].items(), key=lambda kv: kv[0])
        xs = np.array([v[1] for _, v in items])
        ys = np.array([v[2] for _, v in items])
        mx, my = xs.mean(), ys.mean()
        j = int(np.argmin((xs - mx) ** 2 + (ys - my) ** 2))
        pc = Counter(v[3] for _, v in items).most_common(1)[0][0]
        mi = muni_info.get(code, {})
        pop = 2_100_000 if code.startswith("751") else (mi.get("pop") or 0)  # voies de Paris : importance de Paris
        imp = 0.25 + 0.2 * min(1.0, math.log10(len(items) + 1) / 2.5) + 0.25 * (min(1.0, math.log10(pop) / 6.3) if pop > 1 else 0.3)
        start = len(numbers)
        for _, (disp, x, y, apc) in items:
            numbers.append(disp)
            addr_lon.append(x)
            addr_lat.append(y)
            addr_pc.append(pc_table.setdefault(apc, len(pc_table)))
        docs.append({"t": "street", "name": name, "pc": pc, "cc": code, "city": mi.get("city", s["city"]), "lon": float(xs[j]),
                     "lat": float(ys[j]), "imp": round(imp, 4), "id": f"{code}_{voie}", "a0": start, "an": len(items)})
    log(f"{len(docs)} documents (voies + communes)")

    # KD-tree des adresses → code postal / commune des POI et lieux-dits
    A = proj(addr_lon, addr_lat)
    tree = cKDTree(A)
    street_of_addr = np.zeros(len(numbers), np.int32)
    for di, d in enumerate(docs):
        if d["t"] == "street":
            street_of_addr[d["a0"]: d["a0"] + d["an"]] = di
    pcs_rev = {v: k for k, v in pc_table.items()}

    def locate(lon, lat, maxd=2500):
        dist, i = tree.query(proj([lon], [lat])[0])
        if not np.isfinite(dist) or dist > maxd:
            return None
        d = docs[street_of_addr[i]]
        return {"pc": pcs_rev[addr_pc[i]], "cc": d["cc"], "city": d["city"]}

    # ---- lieux-dits / quartiers (type locality) ----------------------------------------------------
    n_loc = 0
    seen_loc = set()
    for d in divisions:
        st, lt = d["subtype"], d["lt"]
        if st == "locality" and d["class"] in ("hamlet",):
            imp = 0.35
        elif st == "neighborhood" or (st == "macrohood" and "Arrondissement" not in d["name"]) or (st == "microhood" and lt == "quarter"):
            imp = 0.5 if st == "macrohood" else 0.45 if st == "neighborhood" else 0.35
        else:
            continue
        key = (norm(d["name"]), round(d["lon"], 2), round(d["lat"], 2))
        if key in seen_loc:
            continue
        seen_loc.add(key)
        loc = locate(d["lon"], d["lat"])
        if not loc:
            continue
        docs.append({"t": "locality", "name": d["name"], "pc": loc["pc"], "cc": loc["cc"], "city": loc["city"],
                     "lon": d["lon"], "lat": d["lat"], "imp": imp, "id": f"{loc['cc']}_loc_{n_loc}"})
        n_loc += 1

    # ---- POI ------------------------------------------------------------------------------------
    pois = []  # {name, cat, lon, lat, imp, alias, pc?, cc?, city?, conf}

    notable = json.load(open(os.path.join(HERE, "notable.json")))["places"]
    places = []
    for region in REGIONS:
        t = pq.read_table(os.path.join(CACHE, f"place__{region}.parquet"),
                          columns=["names", "confidence", "taxonomy", "operating_status", "geometry"])
        g = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
        for i, r in enumerate(t.select(["names", "confidence", "taxonomy", "operating_status"]).to_pylist()):
            if shapely.get_type_id(g[i]) != 0:
                continue
            places.append({"name": (r["names"] or {}).get("primary"), "conf": r["confidence"] or 0,
                           "cat": (r["taxonomy"] or {}).get("primary"), "status": r["operating_status"],
                           "lon": g[i].x, "lat": g[i].y})
    P = proj([p["lon"] for p in places], [p["lat"] for p in places])
    ptree = cKDTree(P)

    # Lieux notables : position affinée sur la place Overture correspondante (si trouvée)
    for n in notable:
        lon, lat = n["lon"], n["lat"]
        if n.get("match"):
            words = norm(" ".join(n["match"])).split()
            best = None
            for i in ptree.query_ball_point(proj([lon], [lat])[0], 600):
                p = places[i]
                nn = norm(p["name"] or "").split()
                if p["conf"] >= 0.9 and all(w in nn for w in words) and (best is None or p["conf"] > best["conf"]):
                    best = p
            if best:
                lon, lat = best["lon"], best["lat"]
        pois.append({"name": n["name"], "cat": n["category"], "lon": lon, "lat": lat, "imp": n.get("importance", 0.7),
                     "alias": n.get("aliases", []), "pc": n.get("postcode"), "cc": n.get("citycode"), "city": n.get("city"),
                     "curated": True, "src": 0})

    # Gares et stations de métro (OSM via Overture infrastructure), regroupées par nom (< 600 m)
    MAJOR = {"Gare de Lyon", "Gare du Nord", "Gare de l'Est", "Paris-Saint-Lazare", "Paris Saint-Lazare", "Gare Saint-Lazare",
             "Gare Montparnasse", "Paris Montparnasse", "Gare d'Austerlitz", "Paris Austerlitz", "Gare de Bercy", "Paris Gare du Nord",
             "Nice-Ville", "Nice Ville", "Massy TGV", "Aéroport Charles de Gaulle 2 TGV", "Versailles Chantiers", "La Défense"}
    stations = []
    for region in REGIONS:
        t = pq.read_table(os.path.join(CACHE, f"infrastructure__{region}.parquet"),
                          columns=["names", "subtype", "class", "source_tags", "geometry"])
        g = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
        for i, r in enumerate(t.select(["names", "subtype", "class", "source_tags"]).to_pylist()):
            name = (r["names"] or {}).get("primary")
            if r["subtype"] != "transit" or not name or r["class"] not in ("railway_station", "subway_station"):
                continue
            c = shapely.point_on_surface(g[i])
            tags = dict(r["source_tags"] or [])
            base = re.sub(r"\s*\((?:m[ée]tro|paris m[ée]tro|m[ée]tro de paris|rer|sncf)[^)]*\)\s*$", "", name, flags=re.I).strip()
            sncf = bool(re.search(r"TGV|TER|Transilien|Intercit|SNCF|Ouigo", tags.get("network", "") + " " + tags.get("operator", "")))
            stations.append({"base": base, "kind": r["class"], "tags": tags, "sncf": sncf, "lon": c.x, "lat": c.y})
    stations.sort(key=lambda s: (s["kind"] != "railway_station", not s["sncf"]))
    kept: list[dict] = []
    for st in stations:
        dup = next((k for k in kept if k["kind"] == st["kind"] and norm(k["base"]) == norm(st["base"])
                    and abs(k["lon"] - st["lon"]) < 0.008 and abs(k["lat"] - st["lat"]) < 0.005), None)
        if not dup:
            kept.append(st)
    for st in kept:
        if st["kind"] == "railway_station":
            pois.append({"name": station_display(st["base"], st["tags"]), "cat": "station", "lon": st["lon"], "lat": st["lat"],
                         "imp": 0.88 if st["base"] in MAJOR else 0.7 if "Gare" in station_display(st["base"], st["tags"]) else 0.65,
                         "alias": ["gare", "sncf", "rer", "train", st["base"]], "src": 1})
        else:
            pois.append({"name": f"Métro {st['base']}", "cat": "metro", "lon": st["lon"], "lat": st["lat"], "imp": 0.6,
                         "alias": ["station", "metro"], "src": 1})

    # Hôpitaux, universités, stades, parcs, cimetières nommés (OSM via land_use)
    LU = {"hospital": ("hospital", 0.52), "university": ("university", 0.45), "stadium": ("stadium", 0.5),
          "park": ("park", 0.45), "cemetery": ("cemetery", 0.4), "zoo": ("attraction", 0.5)}
    for region in REGIONS:
        t = pq.read_table(os.path.join(CACHE, f"land_use__{region}.parquet"), columns=["names", "subtype", "class", "geometry"])
        g = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
        area = shapely.area(g) * 111.32 * 111.32 * 0.66
        for i, r in enumerate(t.select(["names", "subtype", "class"]).to_pylist()):
            name = (r["names"] or {}).get("primary")
            if not name or r["class"] not in LU or shapely.get_type_id(g[i]) not in (3, 6):
                continue
            if area[i] < (0.02 if r["class"] in ("park", "cemetery") else 0.003):
                continue
            c = shapely.point_on_surface(g[i])
            cat, imp = LU[r["class"]]
            if r["class"] == "park" and area[i] > 0.5:
                imp = 0.55
            pois.append({"name": name, "cat": cat, "lon": c.x, "lat": c.y, "imp": imp, "alias": [], "src": 1})

    # POI Overture places (nettoyés)
    muni_names = {norm(d["name"]) for d in docs if d["t"] == "municipality"} | {norm(d["city"]) for d in docs if d["t"] == "municipality"}
    cat_counts = Counter()
    for p in places:
        m = PLACE_CATS.get(p["cat"]) or (("museum", 0.8, 0.52) if (p["cat"] or "").endswith("_museum") else None)
        if not m or p["conf"] < m[1] or (p["status"] and p["status"] != "open"):
            continue
        name = clean_name(p["name"])
        if not name or STREETLIKE.match(name) or norm(name) in muni_names or len(norm(name)) < 4:
            continue
        imp = m[2] + (0.05 if p["conf"] >= 0.98 else 0)
        pois.append({"name": name, "cat": m[0], "lon": p["lon"], "lat": p["lat"], "imp": imp, "alias": [], "conf": p["conf"], "src": 2})
        cat_counts[m[0]] += 1
    log("POI Overture places retenus :", dict(cat_counts))

    # Dédoublonnage (priorité : liste notable > OSM > Overture places, puis importance) :
    # - nom identique (sans mots vides) d'un lieu notable → supprimé où qu'il soit ;
    # - même nom à moins de 400 m (hôtels) / 3 km (autres catégories) → supprimé.
    STOPW = {"de", "du", "des", "la", "le", "les", "l", "d", "a", "au", "aux", "et"}

    def key(n):
        return " ".join(w for w in norm(n).split() if w not in STOPW)

    pois.sort(key=lambda p: (p["src"], -p["imp"], -p.get("conf", 1)))
    curated_keys = {key(x) for p in pois if p.get("curated") for x in [p["name"], *p["alias"]] if len(key(x)) >= 5}
    Pp = proj([p["lon"] for p in pois], [p["lat"] for p in pois])
    ktree = cKDTree(Pp)
    keep = np.ones(len(pois), bool)
    keys = [key(p["name"]) for p in pois]
    for i, p in enumerate(pois):
        if not p.get("curated") and keys[i] in curated_keys:
            keep[i] = False
    for i in range(len(pois)):
        if not keep[i]:
            continue
        radius = 400 if pois[i]["cat"] == "hotel" else 3000
        for j in ktree.query_ball_point(Pp[i], radius):
            if j > i and keep[j] and keys[j] == keys[i]:
                keep[j] = False
    pois = [p for p, k in zip(pois, keep) if k]
    n_poi = 0
    for p in pois:
        loc = locate(p["lon"], p["lat"], 5000)
        pc = p.get("pc") or (loc or {}).get("pc")
        cc = p.get("cc") or (loc or {}).get("cc")
        city = p.get("city") or (loc or {}).get("city")
        if not pc or not cc:
            continue
        docs.append({"t": "poi", "name": p["name"], "pc": pc, "cc": cc, "city": city, "lon": p["lon"], "lat": p["lat"],
                     "imp": round(p["imp"], 4), "id": f"poi_{n_poi}", "cat": p["cat"], "alias": p["alias"]})
        n_poi += 1
    log(f"{n_loc} lieux-dits/quartiers, {n_poi} POI")

    # ---- écriture ------------------------------------------------------------------------------
    for d in docs:
        d["lon"], d["lat"] = round(d["lon"], 7), round(d["lat"], 7)
        d["ctx"] = context(d["cc"])
    meta = {"version": 1, "built": time.strftime("%Y-%m-%dT%H:%M:%S"), "source": "Overture Maps (BAN via OpenAddresses, OSM, Overture places)",
            "count": Counter(d["t"] for d in docs), "addresses": len(numbers), "postcodes": [pcs_rev[i] for i in range(len(pcs_rev))]}
    lon_a = np.array(addr_lon, np.float64)
    lat_a = np.array(addr_lat, np.float64)
    pc_a = np.array(addr_pc, np.uint16)
    with open(os.path.join(OUT, "addr.bin.tmp"), "wb") as fh:
        fh.write(lon_a.tobytes())
        fh.write(lat_a.tobytes())
        fh.write(pc_a.tobytes())
    os.replace(os.path.join(OUT, "addr.bin.tmp"), os.path.join(OUT, "addr.bin"))
    with open(os.path.join(OUT, "docs.json.tmp"), "w") as fh:
        json.dump({"meta": meta, "numbers": "|".join(numbers), "docs": docs}, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(os.path.join(OUT, "docs.json.tmp"), os.path.join(OUT, "docs.json"))
    log(f"index écrit ({json.dumps(meta['count'])}) en {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
