#!/usr/bin/env python3
"""Construit le graphe routier (voiture) pour router.mjs depuis les segments Overture.

- Segments `subtype=road` des classes carrossables (motorway … service), zones Paris & Nice.
- Chaque segment est découpé à ses connecteurs (`connectors[].at`, référence linéaire 0..1)
  → une arête entre deux connecteurs, avec sa géométrie.
- Sens de circulation / interdictions : access_restrictions (cf. overture_rules.py),
  évalués au milieu de chaque arête (les plages `between` sont respectées).
- Vitesses fixes par classe (profil urbain) ; bretelles (*_link) 45 km/h ; plafonnées par la
  vitesse maximale légale Overture (`speed_limits.max_speed`) quand elle est renseignée.
- Feux tricolores (Overture infrastructure `traffic_signals`) rattachés au nœud le plus
  proche (< 20 m) → pénalité de franchissement appliquée par le routeur.
- Composantes fortement connexes : seules les arêtes de grandes composantes servent au
  « snapping » (évite d'accrocher un parking privé isolé → NoRoute).

Sortie : .dev-geo/graph.bin (tableaux binaires) + .dev-geo/graph.json (en-tête).
"""
from __future__ import annotations

import json
import math
import os
import sys
import time

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import shapely
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from extract import CACHE, REGIONS, ROOT  # noqa: E402
from overture_rules import DRIVE_SPEEDS, LINK_CLASSES, LINK_SPEED, car_access_at, car_rules, is_link, max_speed_at  # noqa: E402

OUT_BIN = os.path.join(ROOT, ".dev-geo", "graph.bin")
OUT_JSON = os.path.join(ROOT, ".dev-geo", "graph.json")
CLASSES = list(DRIVE_SPEEDS)  # index = code classe
R = 6371008.8


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def cumlen(coords: np.ndarray) -> np.ndarray:
    lon, lat = np.radians(coords[:, 0]), np.radians(coords[:, 1])
    dlat, dlon = np.diff(lat), np.diff(lon)
    a = np.sin(dlat / 2) ** 2 + np.cos(lat[:-1]) * np.cos(lat[1:]) * np.sin(dlon / 2) ** 2
    d = 2 * R * np.arcsin(np.sqrt(np.minimum(1.0, a)))
    return np.concatenate([[0.0], np.cumsum(d)])


def interp(coords, cl, s):
    i = int(np.searchsorted(cl, s, side="right"))
    if i <= 0:
        return coords[0]
    if i >= len(cl):
        return coords[-1]
    seg = cl[i] - cl[i - 1]
    f = 0.0 if seg <= 0 else (s - cl[i - 1]) / seg
    return coords[i - 1] + f * (coords[i] - coords[i - 1])


def main():
    t0 = time.time()
    node_id: dict[str, int] = {}
    node_xy: list[tuple[float, float]] = []
    eu, ev, elen, edur, eflag, ecls, ename, goff = [], [], [], [], [], [], [], [0]
    glon: list[float] = []
    glat: list[float] = []
    names: dict[str, int] = {"": 0}
    stats = {"segments": 0, "skipped_access": 0, "edges": 0}

    def nid(cid, xy):
        i = node_id.get(cid)
        if i is None:
            i = node_id[cid] = len(node_xy)
            node_xy.append((float(xy[0]), float(xy[1])))
        return i

    for region in REGIONS:
        t = pq.read_table(os.path.join(CACHE, f"segment__{region}.parquet"),
                          columns=["subtype", "class", "subclass", "names", "connectors", "road_flags",
                                   "access_restrictions", "routes", "speed_limits", "geometry"])
        mask = [s == "road" and c in DRIVE_SPEEDS for s, c in zip(t.column("subtype").to_pylist(), t.column("class").to_pylist())]
        t = t.filter(pa.array(mask))
        geoms = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
        rows = t.select(["class", "subclass", "names", "connectors", "road_flags", "access_restrictions", "routes",
                         "speed_limits"]).to_pylist()
        log(f"{region}: {len(rows)} segments carrossables")
        for g, r in zip(geoms, rows):
            conns = sorted((c for c in r["connectors"] or [] if c.get("connector_id") is not None), key=lambda c: c["at"])
            if len(conns) < 2:
                continue
            stats["segments"] += 1
            coords = shapely.get_coordinates(g)
            cl = cumlen(coords)
            L = float(cl[-1])
            rules = car_rules(r["access_restrictions"])
            cls = r["class"]
            speed = LINK_SPEED if (cls in LINK_CLASSES and is_link(r["subclass"], r["road_flags"])) else DRIVE_SPEEDS[cls]
            name = (r["names"] or {}).get("primary") or ""
            if not name:
                refs = [x.get("ref") for x in r["routes"] or [] if x.get("ref")]
                name = refs[0] if refs else ""
            nidx = names.setdefault(name, len(names))
            for c0, c1 in zip(conns, conns[1:]):
                a0, a1 = max(0.0, c0["at"]), min(1.0, c1["at"])
                if c0["connector_id"] == c1["connector_id"]:
                    continue
                fwd, bwd = car_access_at(rules, (a0 + a1) / 2)
                if not (fwd or bwd):
                    stats["skipped_access"] += 1
                    continue
                s0, s1 = a0 * L, a1 * L
                p0, p1 = interp(coords, cl, s0), interp(coords, cl, s1)
                inner = coords[(cl > s0 + 1e-6) & (cl < s1 - 1e-6)]
                pts = np.vstack([p0, inner, p1]) if len(inner) else np.vstack([p0, p1])
                u, v = nid(c0["connector_id"], p0), nid(c1["connector_id"], p1)
                length = max(0.1, float(cumlen(pts)[-1]))
                legal = max_speed_at(r["speed_limits"], (a0 + a1) / 2)
                edge_speed = min(speed, legal) if legal and legal >= 5 else speed
                eu.append(u)
                ev.append(v)
                elen.append(length)
                edur.append(length / (edge_speed / 3.6))
                eflag.append((1 if fwd else 0) | (2 if bwd else 0))
                ecls.append(CLASSES.index(cls))
                ename.append(nidx)
                glon.extend(pts[:, 0].tolist())
                glat.extend(pts[:, 1].tolist())
                goff.append(len(glon))
    N, E = len(node_xy), len(eu)
    stats["edges"] = E
    log(f"graphe : {N} nœuds, {E} arêtes, {len(glon)} points de géométrie")

    eu_a, ev_a = np.array(eu, np.int32), np.array(ev, np.int32)
    flags = np.array(eflag, np.uint8)
    # Composantes fortement connexes
    fw, bw = (flags & 1) > 0, (flags & 2) > 0
    rows = np.concatenate([eu_a[fw], ev_a[bw]])
    cols = np.concatenate([ev_a[fw], eu_a[bw]])
    m = csr_matrix((np.ones(len(rows), np.int8), (rows, cols)), shape=(N, N))
    ncomp, labels = connected_components(m, directed=True, connection="strong")
    sizes = np.bincount(labels)
    big = sizes[labels] >= 1000
    snappable = big[eu_a] & big[ev_a] & (labels[eu_a] == labels[ev_a])
    flags = flags | np.where(snappable, 4, 0).astype(np.uint8)
    log(f"{ncomp} composantes fortes ; {int(big.sum())} nœuds dans les grandes ; {int(snappable.sum())} arêtes « snappables »")

    # Feux tricolores → nœuds
    xy = np.array(node_xy)
    penalty = np.zeros(N, np.float32)
    lat0 = math.radians(46.0)
    proj = np.column_stack([xy[:, 0] * 111320 * math.cos(lat0), xy[:, 1] * 110540])
    tree = cKDTree(proj)
    n_sig = 0
    for region in REGIONS:
        it = pq.read_table(os.path.join(CACHE, f"infrastructure__{region}.parquet"), columns=["subtype", "class", "geometry"])
        sel = [c == "traffic_signals" for c in it.column("class").to_pylist()]
        it = it.filter(pa.array(sel))
        pts = shapely.get_coordinates(shapely.from_wkb(it.column("geometry").to_numpy(zero_copy_only=False)))
        if not len(pts):
            continue
        q = np.column_stack([pts[:, 0] * 111320 * math.cos(lat0), pts[:, 1] * 110540])
        d, idx = tree.query(q, distance_upper_bound=20)
        ok = np.isfinite(d)
        penalty[idx[ok]] = 1.0  # marqueur « feu » (la durée est paramétrée côté routeur)
        n_sig += int(ok.sum())
    log(f"{n_sig} feux rattachés à {int((penalty > 0).sum())} nœuds")

    arrays = [
        ("nodeLon", xy[:, 0].astype(np.float64)),
        ("nodeLat", xy[:, 1].astype(np.float64)),
        ("nodeSignal", penalty.astype(np.uint8)),
        ("edgeU", eu_a),
        ("edgeV", ev_a),
        ("edgeLen", np.array(elen, np.float32)),
        ("edgeDur", np.array(edur, np.float32)),
        ("edgeFlags", flags),
        ("edgeClass", np.array(ecls, np.uint8)),
        ("edgeName", np.array(ename, np.int32)),
        ("geomOff", np.array(goff, np.int32)),
        ("geomLon", np.array(glon, np.float64)),
        ("geomLat", np.array(glat, np.float64)),
    ]
    header = {"version": 1, "nodes": N, "edges": E, "points": len(glon), "classes": CLASSES,
              "speeds": DRIVE_SPEEDS, "linkSpeed": LINK_SPEED, "arrays": {}, "stats": stats,
              "built": time.strftime("%Y-%m-%dT%H:%M:%S"), "source": "Overture Maps transportation/segment"}
    off = 0
    tmp = OUT_BIN + ".tmp"
    with open(tmp, "wb") as fh:
        for name, arr in arrays:
            pad = (-off) % 8
            fh.write(b"\0" * pad)
            off += pad
            b = arr.tobytes()
            header["arrays"][name] = {"offset": off, "length": int(arr.size), "dtype": str(arr.dtype)}
            fh.write(b)
            off += len(b)
    os.replace(tmp, OUT_BIN)
    header["names"] = [n for n, _ in sorted(names.items(), key=lambda kv: kv[1])]
    json.dump(header, open(OUT_JSON, "w"), ensure_ascii=False)
    log(f"écrit {OUT_BIN} ({off / 1e6:.1f} Mo) en {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
