#!/usr/bin/env python3
"""Extraction régionale des données Overture Maps (Paris & Nice) vers .dev-geo/cache/overture.

- Liste les fichiers parquet d'un type Overture sur S3 (anonyme).
- Lit les footers (HTTP Range) → bbox de chaque row group (mis en cache JSON).
- Ne télécharge que les row groups qui intersectent les zones, filtre les lignes
  sur leur bbox, et écrit un GeoParquet (WKB) par (type, zone).

Idempotent : un fichier déjà présent dans le cache n'est pas re-téléchargé.
Usage : extract.py [type ...]   (défaut : tous)
"""
from __future__ import annotations

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from overture_io import RELEASE, bbox_col_index, intersects, list_parts, open_parquet, rowgroup_bbox  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CACHE = os.path.join(ROOT, ".dev-geo", "cache", "overture")
FOOTERS = os.path.join(ROOT, ".dev-geo", "cache", "footers")

# Zones (xmin, ymin, xmax, ymax) en WGS84
REGIONS = {
    "paris": (2.10, 48.68, 2.65, 49.06),
    "nice": (7.10, 43.62, 7.40, 43.78),
}
# Bâtiments : uniquement les centres (poids des tuiles)
BUILDING_REGIONS = {
    "paris": (2.22, 48.80, 2.47, 48.92),
    "nice": (7.22, 43.68, 7.30, 43.73),
}
# Libellés de villes à bas zoom : France métropolitaine entière (divisions seulement)
FRANCE = (-5.5, 41.2, 9.8, 51.2)

# (thème, type) → (colonnes, zones)
JOBS: dict[str, tuple[str, str, list[str], dict]] = {
    "segment": ("transportation", "segment", [
        "id", "subtype", "class", "subclass", "names.primary", "connectors", "road_flags", "rail_flags",
        "level_rules", "access_restrictions", "routes", "speed_limits", "geometry", "bbox"], REGIONS),
    "water": ("base", "water", ["id", "names.primary", "subtype", "class", "is_salt", "is_intermittent", "level", "source_tags", "geometry", "bbox"], REGIONS),
    "land_use": ("base", "land_use", ["id", "names.primary", "subtype", "class", "level", "source_tags", "geometry", "bbox"], REGIONS),
    "land": ("base", "land", ["id", "names.primary", "subtype", "class", "geometry", "bbox"], REGIONS),
    "infrastructure": ("base", "infrastructure", ["id", "names.primary", "subtype", "class", "level", "height", "source_tags", "geometry", "bbox"], REGIONS),
    "building": ("buildings", "building", ["id", "names.primary", "subtype", "class", "height", "num_floors", "min_height",
                                            "is_underground", "has_parts", "geometry", "bbox"], BUILDING_REGIONS),
    "division": ("divisions", "division", ["id", "names", "subtype", "class", "admin_level", "country", "region", "population",
                                          "local_type", "hierarchies", "parent_division_id", "cartography", "wikidata", "sources",
                                          "geometry", "bbox"], {**REGIONS, "france": FRANCE}),
    "division_area": ("divisions", "division_area", ["id", "names.primary", "subtype", "class", "admin_level", "division_id",
                                                     "is_land", "geometry", "bbox"], REGIONS),
    "place": ("places", "place", ["id", "names", "confidence", "basic_category", "taxonomy", "addresses", "brand",
                                   "operating_status", "websites", "geometry", "bbox"], REGIONS),
    "address": ("addresses", "address", ["id", "street", "number", "unit", "postcode", "postal_city", "address_levels",
                                          "country", "sources", "geometry", "bbox"], REGIONS),
}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def footer_index(theme: str, typ: str, parts) -> dict:
    """{clé: [bbox row group, ...]} (mis en cache sur disque)."""
    os.makedirs(FOOTERS, exist_ok=True)
    path = os.path.join(FOOTERS, f"{RELEASE}__{typ}.json")
    idx = json.load(open(path)) if os.path.exists(path) else {}
    todo = [(k, s) for k, s in parts if k not in idx]
    if todo:
        log(f"  {typ}: lecture de {len(todo)} footers…")

        def one(ks):
            k, s = ks
            pf, _ = open_parquet(k, s)
            md = pf.metadata
            ci = bbox_col_index(md)
            return k, [rowgroup_bbox(md, i, ci) for i in range(md.num_row_groups)]

        with ThreadPoolExecutor(12) as ex:
            for n, fut in enumerate(as_completed([ex.submit(one, ks) for ks in todo])):
                k, bbs = fut.result()
                idx[k] = bbs
                if n % 32 == 31:
                    log(f"    {n + 1}/{len(todo)}")
        json.dump(idx, open(path, "w"))
    return idx


def row_mask(tbl: pa.Table, b) -> pa.ChunkedArray:
    bb = tbl.column("bbox")
    xmin = pc.struct_field(bb, "xmin")
    xmax = pc.struct_field(bb, "xmax")
    ymin = pc.struct_field(bb, "ymin")
    ymax = pc.struct_field(bb, "ymax")
    return pc.and_(pc.and_(pc.greater_equal(xmax, b[0]), pc.less_equal(xmin, b[2])),
                   pc.and_(pc.greater_equal(ymax, b[1]), pc.less_equal(ymin, b[3])))


def extract(name: str):
    theme, typ, cols, regions = JOBS[name]
    outs = {r: os.path.join(CACHE, f"{name}__{r}.parquet") for r in regions}
    if all(os.path.exists(p) for p in outs.values()):
        log(f"{name}: déjà en cache")
        return
    os.makedirs(CACHE, exist_ok=True)
    t0 = time.time()
    parts = list_parts(theme, typ)
    sizes = dict(parts)
    idx = footer_index(theme, typ, parts)
    # row groups à lire : (clé, index rg) → zones concernées
    work: dict[str, list[int]] = {}
    for k, bbs in idx.items():
        if k not in sizes:
            continue
        for i, bb in enumerate(bbs):
            if bb is None or any(intersects(bb, rb) for rb in regions.values()):
                work.setdefault(k, []).append(i)
    n_rg = sum(len(v) for v in work.values())
    log(f"{name}: {n_rg} row groups à lire dans {len(work)} fichiers")
    results: dict[str, list[pa.Table]] = {r: [] for r in regions}
    fetched = [0]

    def read_file(k: str, rgs: list[int]):
        pf, f = open_parquet(k, sizes[k])
        out = {r: [] for r in regions}
        for i in rgs:
            tbl = pf.read_row_group(i, columns=cols)
            for r, b in regions.items():
                sub = tbl.filter(row_mask(tbl, b))
                if sub.num_rows:
                    out[r].append(sub)
        fetched[0] += f.bytes_fetched
        return out

    done = 0
    with ThreadPoolExecutor(8) as ex:
        futs = [ex.submit(read_file, k, rgs) for k, rgs in work.items()]
        for fut in as_completed(futs):
            for r, tabs in fut.result().items():
                results[r].extend(tabs)
            done += 1
            if done % 10 == 0:
                log(f"  {name}: {done}/{len(futs)} fichiers, {fetched[0] / 1e6:.0f} Mo")
    for r, tabs in results.items():
        if tabs:
            tbl = pa.concat_tables(tabs, promote_options="permissive")
        else:
            tbl = pa.table({"id": pa.array([], pa.string())})
        tmp = outs[r] + ".tmp"
        pq.write_table(tbl, tmp, compression="zstd")
        os.replace(tmp, outs[r])
        log(f"{name}/{r}: {tbl.num_rows} lignes → {os.path.basename(outs[r])}")
    log(f"{name}: terminé en {time.time() - t0:.0f}s ({fetched[0] / 1e6:.0f} Mo téléchargés)")


if __name__ == "__main__":
    names = sys.argv[1:] or list(JOBS)
    for n in names:
        extract(n)
