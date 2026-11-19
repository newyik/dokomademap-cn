#!/usr/bin/env python3
"""
Fetch Japan car-camping (车中泊) spots from OpenStreetMap Overpass API:
  - 道の駅 (Michi-no-Eki roadside stations)
  - RVパーク / caravan_site (dedicated RV / car-camping sites)
  - 高速道路 SA (highway=services, 24h service areas)

Deduplicates overlapping OSM features, attaches elevation & nearest road node
from public/data/graph.bin, and links the nearest Supercharger from superchargers.json.
"""

import json
import math
import os
import struct
import urllib.parse
import urllib.request

import numpy as np
from scipy.spatial import cKDTree

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "public", "data")
OVERPASS_EP = "https://maps.mail.ru/osm/tools/overpass/api/interpreter"


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def fetch_overpass():
    q = """[out:json][timeout:90];
area["ISO3166-1"="JP"]->.jp;
(
  nwr["name"~"道の駅"]["amenity"!="bus_station"]["railway"!~"station"]["highway"!~"bus_stop"](area.jp);
  nwr["tourism"="caravan_site"](area.jp);
  nwr["highway"="services"]["name"](area.jp);
);
out center tags;"""
    req = urllib.request.Request(
        OVERPASS_EP,
        data=urllib.parse.urlencode({"data": q}).encode(),
        headers={"User-Agent": "DokomadeMapCN/1.0"},
    )
    print("Querying Overpass for Japan Michi-no-Eki, RV parks, and Highway SAs...")
    with urllib.request.urlopen(req, timeout=90) as r:
        data = json.loads(r.read().decode("utf-8"))
    print(f"Fetched {len(data['elements'])} raw OSM elements")
    return data["elements"]


def load_graph_nodes():
    buf = open(os.path.join(DATA_DIR, "graph.bin"), "rb").read()
    n, _ = struct.unpack_from("<II", buf, 4)
    off = 12
    lats = np.frombuffer(buf, dtype=np.float32, count=n, offset=off).copy(); off += n * 4
    lons = np.frombuffer(buf, dtype=np.float32, count=n, offset=off).copy(); off += n * 4
    elevs = np.frombuffer(buf, dtype=np.int16, count=n, offset=off).copy()
    return lats, lons, elevs


def classify_spot(tags: dict):
    name = (tags.get("name:zh") or tags.get("name") or tags.get("name:ja") or "").strip()
    if not name:
        return None
    # Skip non-destination bus stops or tiny roadside signs
    if tags.get("public_transport") or tags.get("highway") == "bus_stop":
        return None

    tourism = tags.get("tourism", "")
    hw = tags.get("highway", "")

    if tourism == "caravan_site" or "RVパーク" in name or "rvパーク" in name.lower():
        kind = "rv"
    elif "道の駅" in name:
        kind = "michi"
    elif hw == "services":
        kind = "sa"
    else:
        return None

    # Normalize noisy OSM suffixes
    return {
        "name": name,
        "kind": kind,  # michi | rv | sa
        "toilets": tags.get("toilets") != "no" and (kind in ("michi", "sa") or tags.get("toilets") == "yes"),
        "shower": tags.get("shower") == "yes",
        "power": tags.get("power_supply") in ("yes", "100V", "200V") or kind == "rv",
        "onsen": any(k in name for k in ("温泉", "ゆ", "湯", "スパ")) or tags.get("hot_spring") == "yes",
    }


def main():
    elements = fetch_overpass()
    lats, lons, elevs = load_graph_nodes()
    scs = json.load(open(os.path.join(DATA_DIR, "superchargers.json"), encoding="utf-8"))

    cos35 = math.cos(math.radians(35.5))
    node_xy = np.column_stack([lons * 111320.0 * cos35, lats * 110940.0])
    road_tree = cKDTree(node_xy)

    sc_xy = np.column_stack([
        np.array([s["lon"] for s in scs]) * 111320.0 * cos35,
        np.array([s["lat"] for s in scs]) * 110940.0,
    ])
    sc_tree = cKDTree(sc_xy)

    candidates = []
    for el in elements:
        tags = el.get("tags", {})
        info = classify_spot(tags)
        if not info:
            continue
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        if not (24.0 <= lat <= 45.8 and 122.8 <= lon <= 145.9):
            continue
        info["lat"] = round(float(lat), 5)
        info["lon"] = round(float(lon), 5)
        # Prefer nodes/ways with richer tags when deduplicating
        info["_score"] = (1 if el["type"] == "node" else 0) + (2 if info["power"] else 0) + (1 if info["onsen"] else 0)
        candidates.append(info)

    # Sort higher score first, deduplicate spots within 600m of same kind
    candidates.sort(key=lambda x: -x["_score"])
    kept = []
    kept_xy = []
    for c in candidates:
        px = c["lon"] * 111320.0 * cos35
        py = c["lat"] * 110940.0
        dup = False
        for kx, ky, kkind in kept_xy:
            if kkind == c["kind"] and math.hypot(px - kx, py - ky) < 600.0:
                dup = True
                break
        if dup:
            continue

        # Snap to nearest road node
        d_road, n_idx = road_tree.query([px, py])
        if d_road > 25000.0:
            continue
        n_idx = int(n_idx)

        # Nearest Supercharger
        _, sc_idx = sc_tree.query([px, py])
        sc_idx = int(sc_idx)
        sc_km = round(haversine_km(c["lat"], c["lon"], scs[sc_idx]["lat"], scs[sc_idx]["lon"]), 1)

        kept.append({
            "name": c["name"],
            "kind": c["kind"],
            "lat": c["lat"],
            "lon": c["lon"],
            "elev": int(elevs[n_idx]),
            "node": n_idx,
            "sc_idx": sc_idx,
            "sc_km": sc_km,
            "t": 1 if c["toilets"] else 0,
            "s": 1 if c["shower"] else 0,
            "p": 1 if c["power"] else 0,
            "o": 1 if c["onsen"] else 0,
        })
        kept_xy.append((px, py, c["kind"]))

    out_path = os.path.join(DATA_DIR, "camp_spots.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(kept, f, ensure_ascii=False)

    counts = {k: sum(1 for x in kept if x["kind"] == k) for k in ("michi", "rv", "sa")}
    sz_kb = os.path.getsize(out_path) / 1024.0
    print(f"Saved {len(kept)} car-camping spots ({counts}) -> {out_path} ({sz_kb:.1f} KB)")


if __name__ == "__main__":
    main()
