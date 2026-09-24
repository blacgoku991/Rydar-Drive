"""Accès HTTP « range » aux GeoParquet Overture Maps (S3 public, anonyme).

Lit uniquement les footers parquet, sélectionne les row groups dont les
statistiques bbox.* intersectent la zone voulue, puis ne télécharge que ceux-là.
Respecte HTTPS_PROXY et REQUESTS_CA_BUNDLE (jamais de désactivation TLS).
"""
from __future__ import annotations

import os
import re
import threading
import time
import xml.etree.ElementTree as ET

import pyarrow.parquet as pq
import requests

BUCKET = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com"
RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-09-23.0")

if "REQUESTS_CA_BUNDLE" not in os.environ and os.path.exists("/root/.ccr/ca-bundle.crt"):
    os.environ["REQUESTS_CA_BUNDLE"] = "/root/.ccr/ca-bundle.crt"

_local = threading.local()


def session() -> requests.Session:
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=8)
        s.mount("https://", adapter)
        _local.s = s
    return s


def http_get(url: str, headers: dict | None = None, tries: int = 6) -> requests.Response:
    last = None
    for i in range(tries):
        try:
            r = session().get(url, headers=headers or {}, timeout=120)
            if r.status_code in (200, 206):
                return r
            last = RuntimeError(f"HTTP {r.status_code} {url}")
        except requests.RequestException as e:  # coupure réseau → on réessaie
            last = e
        time.sleep(1.5 * (i + 1))
    raise last  # type: ignore[misc]


def list_parts(theme: str, typ: str) -> list[tuple[str, int]]:
    """Liste (clé, taille) des fichiers parquet d'un type Overture."""
    prefix = f"release/{RELEASE}/theme={theme}/type={typ}/"
    out: list[tuple[str, int]] = []
    token = None
    ns = "{http://s3.amazonaws.com/doc/2006-03-01/}"
    while True:
        url = f"{BUCKET}/?list-type=2&prefix={prefix}"
        if token:
            url += "&continuation-token=" + requests.utils.quote(token, safe="")
        root = ET.fromstring(http_get(url).content)
        for c in root.findall(f"{ns}Contents"):
            key = c.find(f"{ns}Key").text
            size = int(c.find(f"{ns}Size").text)
            if key.endswith(".parquet") or re.search(r"part-\d+", key):
                out.append((key, size))
        if root.find(f"{ns}IsTruncated").text == "true":
            token = root.find(f"{ns}NextContinuationToken").text
        else:
            break
    return out


class RangeFile:
    """Objet fichier en lecture seule, chaque read() = GET Range (avec petit cache de blocs)."""

    BLOCK = 1 << 20  # 1 Mo : regroupe les petites lectures (footer, pages)

    def __init__(self, key: str, size: int):
        self.url = f"{BUCKET}/{key}"
        self.size = size
        self.pos = 0
        self.closed = False
        self._cache: dict[int, bytes] = {}
        self.bytes_fetched = 0

    # --- API fichier minimale attendue par pyarrow ---
    def seekable(self):
        return True

    def readable(self):
        return True

    def writable(self):
        return False

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        if whence == 0:
            self.pos = off
        elif whence == 1:
            self.pos += off
        else:
            self.pos = self.size + off
        return self.pos

    def close(self):
        self.closed = True

    def _fetch(self, start: int, end: int) -> bytes:  # end exclusif
        r = http_get(self.url, {"Range": f"bytes={start}-{end - 1}"})
        self.bytes_fetched += len(r.content)
        return r.content

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = max(0, min(n, self.size - self.pos))
        if n == 0:
            return b""
        start, end = self.pos, self.pos + n
        if n >= self.BLOCK:  # grosse lecture : GET direct
            data = self._fetch(start, end)
        else:  # petite lecture : via blocs cachés de 1 Mo
            parts = []
            b0, b1 = start // self.BLOCK, (end - 1) // self.BLOCK
            for b in range(b0, b1 + 1):
                if b not in self._cache:
                    bs = b * self.BLOCK
                    self._cache[b] = self._fetch(bs, min(self.size, bs + self.BLOCK))
                    if len(self._cache) > 64:
                        self._cache.pop(next(iter(self._cache)))
                parts.append(self._cache[b])
            blob = b"".join(parts)
            off = start - b0 * self.BLOCK
            data = blob[off : off + n]
        self.pos = end
        return data

    def readinto(self, buf):
        data = self.read(len(buf))
        buf[: len(data)] = data
        return len(data)


def open_parquet(key: str, size: int) -> tuple[pq.ParquetFile, RangeFile]:
    f = RangeFile(key, size)
    return pq.ParquetFile(f, pre_buffer=False), f


def rowgroup_bbox(md, rg_index: int, col_idx: dict[str, int]):
    """(xmin, ymin, xmax, ymax) d'un row group à partir des statistiques bbox.*.

    NB : on lit min/max tant que les objets métadonnées parents sont vivants
    (pyarrow peut sinon libérer la mémoire sous-jacente → segfault).
    """
    rg = md.row_group(rg_index)
    vals = {}
    for name in ("bbox.xmin", "bbox.xmax", "bbox.ymin", "bbox.ymax"):
        col = rg.column(col_idx[name])
        stats = col.statistics
        if stats is None or not stats.has_min_max:
            return None
        vals[name] = (stats.min, stats.max)
    return (vals["bbox.xmin"][0], vals["bbox.ymin"][0], vals["bbox.xmax"][1], vals["bbox.ymax"][1])


def bbox_col_index(md) -> dict[str, int]:
    idx = {}
    rg = md.row_group(0)
    for i in range(rg.num_columns):
        p = rg.column(i).path_in_schema
        if p.startswith("bbox."):
            idx[p] = i
    return idx


def intersects(a, b) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])
