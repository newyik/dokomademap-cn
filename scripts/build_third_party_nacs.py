#!/usr/bin/env python3
"""
Fetch adapter-free (native NACS / Tesla connector) 3rd-party charging stations in Japan:
  - FLASH NACS ultra-fast chargers (ev-charger.jp/area/locations.json)
Geocode Japanese addresses via GSI AddressSearch (msearch.gsi.go.jp),
snap to the bidirectional road graph (graph.bin), and output public/data/nacs_chargers.json.
"""

import concurrent.futures
import json
import math
import os
import re
import struct
import urllib.parse
import urllib.request

import numpy as np
from scipy.spatial import cKDTree

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "public", "data")
FLASH_URL = "https://ev-charger.jp/area/locations.json"
GSI_ADDR_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch?q="
USER_AGENT = "DokomadeMapCN/1.0"


def load_graph_nodes():
    buf = open(os.path.join(DATA_DIR, "graph.bin"), "rb").read()
    n, _ = struct.unpack_from("<II", buf, 4)
    off = 12
    lats = np.frombuffer(buf, dtype=np.float32, count=n, offset=off).copy(); off += n * 4
    lons = np.frombuffer(buf, dtype=np.float32, count=n, offset=off).copy()
    return lats, lons


def geocode_gsi(addr: str):
    if not addr:
        return None
    # Strip trailing building/floor hints if full address fails
    cleaned = re.sub(r"\s+.*$", "", addr.strip())
    for q in (addr.strip(), cleaned, re.sub(r"[0-9０-９\-−丁目番号]+$", "", cleaned)):
        if not q:
            continue
        try:
            req = urllib.request.Request(GSI_ADDR_URL + urllib.parse.quote(q), headers={"User-Agent": USER_AGENT})
            res = json.loads(urllib.request.urlopen(req, timeout=10).read().decode("utf-8"))
            if res and isinstance(res, list):
                lon, lat = res[0]["geometry"]["coordinates"]
                if 24.0 <= lat <= 45.8 and 122.8 <= lon <= 145.9:
                    return float(lat), float(lon)
        except Exception:
            pass
    return None


def main():
    print("Fetching FLASH NACS stations...")
    req = urllib.request.Request(FLASH_URL, headers={"User-Agent": USER_AGENT})
    raw = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8"))
    nacs_list = [
        x for x in raw
        if "NACS" in (x.get("types") or []) and x.get("status") not in ("closed", "suspended")
    ]
    print(f"Found {len(nacs_list)} active FLASH NACS stations; geocoding via GSI...")

    def worker(item):
        coords = geocode_gsi(item.get("address", ""))
        if not coords:
            return None
        return item, coords

    geocoded = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        for res in ex.map(worker, nacs_list):
            if res:
                geocoded.append(res)

    print(f"Geocoded {len(geocoded)} / {len(nacs_list)} stations; snapping to road network...")
    lats, lons = load_graph_nodes()
    cos35 = math.cos(math.radians(35.5))
    tree = cKDTree(np.column_stack([lons * 111320.0 * cos35, lats * 110940.0]))

    out = []
    for item, (lat, lon) in geocoded:
        px = lon * 111320.0 * cos35
        py = lat * 110940.0
        d, n_idx = tree.query([px, py])
        if d > 20000.0:
            continue
        kw_m = re.search(r"(\d+)\s*kW", item.get("output", ""), re.I)
        kw = int(kw_m.group(1)) if kw_m else 0
        img_rel = (item.get("image") or "").strip()
        img_url = ""
        if img_rel:
            clean_rel = re.sub(r"^\.\.?/", "", img_rel)
            img_url = f"https://ev-charger.jp/{clean_rel}" if not clean_rel.startswith("http") else clean_rel
        out.append({
            "name": item.get("name", ""),
            "brand": "FLASH NACS",
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "kw": kw,
            "hours": item.get("hours", ""),
            "pref": item.get("prefecture", ""),
            "addr": item.get("address", ""),
            "img": img_url,
            "gmap": item.get("map", ""),
            "node": int(n_idx),
        })

    out_path = os.path.join(DATA_DIR, "nacs_chargers.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"Saved {len(out)} adapter-free 3rd-party NACS chargers -> {out_path} ({os.path.getsize(out_path)/1024:.1f} KB)")


if __name__ == "__main__":
    main()
