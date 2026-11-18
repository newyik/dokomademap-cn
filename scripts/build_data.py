#!/usr/bin/env python3
"""
Build independent, self-contained routing graph, elevation-aware edge weights,
landmask coverage grid, car ferry network, and Supercharger index from:
  - OpenStreetMap (japan-latest.osm.pbf)
  - GSI Japan DEM PNG tiles (cyberjapandata.gsi.go.jp)
  - supercharge.info Japan sites JSON

Outputs into public/data/:
  - graph.bin         Compact CSR forward + reverse road/ferry graph
  - landgrid.bin      Mercator Japan land pixels mapped to nearest graph nodes
  - superchargers.json
  - ferries.json
"""

from collections import defaultdict
import json
import math
import os
import re
import struct
import time

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree
import osmium

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(BASE_DIR, "raw_cache")
GSI_Z9_DIR = os.path.join(RAW_DIR, "gsi_z9")
GSI_Z8_GM_DIR = os.path.join(RAW_DIR, "gsi_z8_gm")
OUT_DIR = os.path.join(BASE_DIR, "public", "data")

PBF_PATH = os.path.join(RAW_DIR, "japan-latest.osm.pbf")
SC_RAW_PATH = os.path.join(RAW_DIR, "superchargers_raw.json")

# Mercator grid bounds covering Japan (Hokkaido to Okinawa/Ishigaki)
LAT_MIN, LAT_MAX = 24.0, 45.8
LON_MIN, LON_MAX = 122.8, 145.9
GRID_W = 1200

# Road speeds (km/h) for shortest-time route calculation
ROAD_SPEED_KMH = {
    "motorway": 85.0,
    "motorway_link": 45.0,
    "trunk": 55.0,
    "trunk_link": 40.0,
    "primary": 45.0,
    "primary_link": 35.0,
    "secondary": 38.0,
    "secondary_link": 30.0,
}
MAIN_ROADS = {
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
}
ISLAND_EXTRA_ROADS = {"secondary", "secondary_link"}

# Island bounding boxes (lat_min, lat_max, lon_min, lon_max) where secondary roads are included
ISLAND_BOXES = [
    (24.0, 30.6, 122.8, 131.5),   # Okinawa, Amami, Miyako, Ishigaki, Tokunoshima, etc.
    (37.75, 38.36, 138.18, 138.60),  # Sado Island
    (34.15, 34.63, 134.64, 135.03),  # Awaji Island
    (34.41, 34.56, 134.14, 134.37),  # Shodoshima
    (33.0, 34.85, 139.05, 139.95),   # Izu Islands (Oshima, Niijima, Miyake, Hachijo)
    (34.05, 34.74, 129.14, 129.52),  # Tsushima
    (32.54, 33.36, 128.60, 129.20),  # Goto Islands
    (33.68, 33.90, 129.62, 129.85),  # Iki Island
    (35.98, 36.36, 132.92, 133.38),  # Oki Islands
    (30.20, 30.85, 130.35, 131.12),  # Yakushima & Tanegashima
    (45.05, 45.50, 140.95, 141.36),  # Rishiri & Rebun
    (33.50, 33.95, 132.10, 132.45),  # Suo-Oshima
]


def lat_to_merc_y(lat_deg: float) -> float:
    return math.log(math.tan(math.pi / 4.0 + math.radians(lat_deg) / 2.0))


def merc_y_to_lat(y: float) -> float:
    return math.degrees(2.0 * math.atan(math.exp(y)) - math.pi / 2.0)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2.0) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2.0) ** 2
    return 2.0 * r * math.asin(min(1.0, math.sqrt(a)))


def in_island_box(lat: float, lon: float) -> bool:
    for a, b, c, d in ISLAND_BOXES:
        if a <= lat <= b and c <= lon <= d:
            return True
    return False


class GSIElevationSampler:
    def __init__(self):
        self.cache_z9: dict[tuple[int, int], np.ndarray | None] = {}
        self.cache_z8: dict[tuple[int, int], np.ndarray | None] = {}

    def _load_tile(self, folder: str, cache: dict, tx: int, ty: int) -> np.ndarray | None:
        key = (tx, ty)
        if key in cache:
            return cache[key]
        path = os.path.join(folder, f"{tx}_{ty}.png")
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            cache[key] = None
            return None
        try:
            img = Image.open(path).convert("RGB")
            arr = np.asarray(img, dtype=np.int32)
            # Decode GSI DEM PNG RGB -> float32 meters (NaN for nodata)
            x = (arr[:, :, 0] << 16) + (arr[:, :, 1] << 8) + arr[:, :, 2]
            elev = np.where(
                x == 8388608,
                np.nan,
                np.where(x < 8388608, x * 0.01, (x - 16777216) * 0.01),
            ).astype(np.float32)
            cache[key] = elev
            return elev
        except Exception:
            cache[key] = None
            return None

    def sample(self, lat: float, lon: float) -> float | None:
        lat_c = max(-85.0, min(85.0, lat))
        merc_y = lat_to_merc_y(lat_c)
        # z=9 lookup
        n9 = 512 * 256
        px9 = int((lon + 180.0) / 360.0 * n9)
        py9 = int((1.0 - merc_y / math.pi) / 2.0 * n9)
        px9 = max(0, min(n9 - 1, px9))
        py9 = max(0, min(n9 - 1, py9))
        arr = self._load_tile(GSI_Z9_DIR, self.cache_z9, px9 >> 8, py9 >> 8)
        if arr is not None:
            v = float(arr[py9 & 255, px9 & 255])
            if not math.isnan(v):
                return v

        # z=8 demgm fallback
        n8 = 256 * 256
        px8 = int((lon + 180.0) / 360.0 * n8)
        py8 = int((1.0 - merc_y / math.pi) / 2.0 * n8)
        px8 = max(0, min(n8 - 1, px8))
        py8 = max(0, min(n8 - 1, py8))
        arr8 = self._load_tile(GSI_Z8_GM_DIR, self.cache_z8, px8 >> 8, py8 >> 8)
        if arr8 is not None:
            v = float(arr8[py8 & 255, px8 & 255])
            if not math.isnan(v):
                return v
        return None


def parse_maxspeed_kmh(tags: dict, default_kmh: float) -> float:
    ms = tags.get("maxspeed")
    if not ms:
        return default_kmh
    m = re.match(r"^\s*(\d+)", ms)
    if not m:
        return default_kmh
    val = float(m.group(1))
    # Practical average speed is typically slightly below legal limit on highways / urban roads
    return max(25.0, min(105.0, val * 0.92))


def parse_duration_seconds(dur: str | None) -> int | None:
    if not dur:
        return None
    s = dur.strip()
    # ISO8601 e.g. PT12H30M or PT45M
    m = re.match(r"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$", s, re.IGNORECASE)
    if m and any(m.groups()):
        h = int(m.group(1) or 0)
        mi = int(m.group(2) or 0)
        sec = int(m.group(3) or 0)
        return h * 3600 + mi * 60 + sec
    # HH:MM(:SS)
    m2 = re.match(r"^(\d+):(\d{1,2})(?::(\d{1,2}))?$", s)
    if m2:
        h = int(m2.group(1))
        mi = int(m2.group(2))
        sec = int(m2.group(3) or 0)
        return h * 3600 + mi * 60 + sec
    # Plain minutes
    m3 = re.match(r"^(\d+)\s*(?:min|mins|minutes|分)?$", s, re.IGNORECASE)
    if m3:
        return int(m3.group(1)) * 60
    return None


def is_ev_charging_ferry(name: str, operator: str) -> bool:
    txt = f"{name} {operator}".lower()
    if "阪九" in txt or "hankyu" in txt:
        return True
    if "さんふらわあ" in txt or "sunflower" in txt:
        # Sunflower Osaka-Beppu & Osaka-Shibushi (Kansai-Kyushu) support EV onboard charging
        if any(k in txt for k in ["大阪", "別府", "志布志", "osaka", "beppu", "shibushi", "くれない", "むらさき", "さつま", "きりしま"]):
            return True
    return False


def extract_osm_data():
    t0 = time.time()
    print("[1/5] Pass 1: scanning OSM ways & ferry relations from PBF...")
    road_ways = []
    ferry_ways = {}
    ferry_rel_tags: dict[int, dict] = {}
    needed_nodes = set()

    # Read relations first or in same pass: pyosmium reads nodes, ways, relations in order!
    # So ways come BEFORE relations in PBF. We'll grab relations too and merge tags afterward.
    for obj in osmium.FileProcessor(PBF_PATH).with_filter(
        osmium.filter.EntityFilter(osmium.osm.WAY | osmium.osm.RELATION)
    ):
        if obj.is_way():
            tags = dict(obj.tags)
            hw = tags.get("highway")
            route = tags.get("route")
            nids = [n.ref for n in obj.nodes]
            if len(nids) < 2:
                continue

            if hw in MAIN_ROADS or hw in ISLAND_EXTRA_ROADS:
                if tags.get("access") == "no" or tags.get("motor_vehicle") == "no" or tags.get("motorcar") == "no":
                    continue
                if tags.get("construction") or tags.get("proposed"):
                    continue
                road_ways.append((obj.id, hw, tags, nids))
                needed_nodes.update(nids)
            elif route == "ferry":
                if tags.get("motorcar") == "no" or tags.get("motor_vehicle") == "no" or tags.get("foot") == "only":
                    continue
                ferry_ways[obj.id] = (tags, nids)
                needed_nodes.update(nids)

        elif obj.is_relation():
            tags = dict(obj.tags)
            if tags.get("route") == "ferry":
                if tags.get("motorcar") == "no" or tags.get("motor_vehicle") == "no" or tags.get("foot") == "only":
                    continue
                for m in obj.members:
                    if m.type == "w":
                        ferry_rel_tags[m.ref] = tags

    for wid, rtags in ferry_rel_tags.items():
        if wid in ferry_ways:
            wtags, nids = ferry_ways[wid]
            merged = {**rtags, **wtags}
            ferry_ways[wid] = (merged, nids)

    print(f"      Collected {len(road_ways)} candidate road ways, {len(ferry_ways)} ferries, {len(needed_nodes)} node refs in {time.time() - t0:.1f}s")

    print("[2/5] Pass 2: loading node coordinates from PBF...")
    t1 = time.time()
    node_coords: dict[int, tuple[float, float]] = {}
    for obj in osmium.FileProcessor(PBF_PATH).with_filter(osmium.filter.EntityFilter(osmium.osm.NODE)):
        if obj.id in needed_nodes and obj.location.valid():
            node_coords[obj.id] = (obj.lat, obj.lon)
    print(f"      Loaded {len(node_coords)} node coordinates in {time.time() - t1:.1f}s")

    # Filter island-only secondary roads now that we have node coordinates
    filtered_roads = []
    for wid, hw, tags, nids in road_ways:
        if hw in ISLAND_EXTRA_ROADS:
            c0 = node_coords.get(nids[0])
            if not c0 or not in_island_box(c0[0], c0[1]):
                continue
        filtered_roads.append((wid, hw, tags, nids))

    print(f"      Filtered road ways (main + island secondary): {len(filtered_roads)}")
    return filtered_roads, list(ferry_ways.values()), node_coords


def interpolate_elevations(raw_elevs: list[float | None], dists: list[float], force_linear: bool) -> list[float]:
    n = len(raw_elevs)
    if force_linear:
        # Find first and last valid endpoints
        first_i = next((i for i, v in enumerate(raw_elevs) if v is not None), None)
        last_i = next((i for i in range(n - 1, -1, -1) if raw_elevs[i] is not None), None)
        if first_i is not None and last_i is not None and last_i > first_i:
            v0, v1 = raw_elevs[first_i], raw_elevs[last_i]
            d0, d1 = dists[first_i], dists[last_i]
            span = max(1.0, d1 - d0)
            return [
                v0 if i <= first_i else (v1 if i >= last_i else v0 + (v1 - v0) * (dists[i] - d0) / span)
                for i in range(n)
            ]

    out = list(raw_elevs)
    # Fill gaps by linear interpolation across valid neighbors
    valid_idxs = [i for i, v in enumerate(out) if v is not None]
    if not valid_idxs:
        return [0.0] * n
    for i in range(valid_idxs[0]):
        out[i] = out[valid_idxs[0]]
    for i in range(valid_idxs[-1] + 1, n):
        out[i] = out[valid_idxs[-1]]
    for a, b in zip(valid_idxs, valid_idxs[1:]):
        if b - a > 1:
            va, vb = out[a], out[b]
            da, db = dists[a], dists[b]
            span = max(1.0, db - da)
            for k in range(a + 1, b):
                out[k] = va + (vb - va) * (dists[k] - da) / span
    return [float(v) for v in out]


def build_graph(road_ways, ferry_ways, node_coords, elev_sampler: GSIElevationSampler):
    print("[3/5] Building contracted elevation-aware road graph...")
    t0 = time.time()

    # Count degree of OSM nodes across kept road ways
    deg = defaultdict(int)
    for _, _, _, nids in road_ways:
        valid_nids = [nid for nid in nids if nid in node_coords]
        if len(valid_nids) < 2:
            continue
        deg[valid_nids[0]] += 1
        deg[valid_nids[-1]] += 1
        for nid in valid_nids[1:-1]:
            deg[nid] += 2
        # Endpoints of a way are always kept
        deg[valid_nids[0]] += 10
        deg[valid_nids[-1]] += 10

    kept_osm_to_idx: dict[int, int] = {}
    node_lats: list[float] = []
    node_lons: list[float] = []
    node_elevs: list[int] = []

    def get_or_add_node(osm_id: int, elev_m: float) -> int:
        idx = kept_osm_to_idx.get(osm_id)
        if idx is not None:
            return idx
        lat, lon = node_coords[osm_id]
        idx = len(node_lats)
        kept_osm_to_idx[osm_id] = idx
        node_lats.append(lat)
        node_lons.append(lon)
        node_elevs.append(int(round(max(-500.0, min(4000.0, elev_m)))))
        return idx

    # Pre-sample elevation cache by OSM node id
    osm_elev_cache: dict[int, float | None] = {}

    def get_raw_elev(nid: int) -> float | None:
        if nid in osm_elev_cache:
            return osm_elev_cache[nid]
        lat, lon = node_coords[nid]
        v = elev_sampler.sample(lat, lon)
        osm_elev_cache[nid] = v
        return v

    # Edges: list of (u, v, dist_m, time_s, climb_m, descent_m, flags)
    edges = []

    for _, hw, tags, raw_nids in road_ways:
        nids = [nid for nid in raw_nids if nid in node_coords]
        if len(nids) < 2:
            continue

        base_speed = ROAD_SPEED_KMH[hw]
        speed_kmh = parse_maxspeed_kmh(tags, base_speed)
        speed_mps = speed_kmh / 3.6

        oneway_tag = tags.get("oneway", "")
        if oneway_tag in ("yes", "true", "1"):
            allow_fwd, allow_rev = True, False
        elif oneway_tag == "-1":
            allow_fwd, allow_rev = False, True
        elif hw in ("motorway", "motorway_link") and oneway_tag != "no":
            allow_fwd, allow_rev = True, False
        else:
            allow_fwd, allow_rev = True, True

        # Cumulative distance and elevation along this way
        cum_dists = [0.0]
        for i in range(1, len(nids)):
            la1, lo1 = node_coords[nids[i - 1]]
            la2, lo2 = node_coords[nids[i]]
            cum_dists.append(cum_dists[-1] + haversine_m(la1, lo1, la2, lo2))

        raw_elevs = [get_raw_elev(nid) for nid in nids]
        is_tunnel_or_bridge = tags.get("tunnel") == "yes" or tags.get("bridge") == "yes"
        elevs = interpolate_elevations(raw_elevs, cum_dists, force_linear=is_tunnel_or_bridge)

        # Split at intersection/endpoint nodes (deg != 2) and subdivide segments > 2200m
        seg_start_i = 0
        last_split_dist = 0.0
        for i in range(1, len(nids)):
            nid = nids[i]
            is_end = (i == len(nids) - 1)
            is_junction = deg[nid] != 2
            too_long = (cum_dists[i] - last_split_dist) >= 2200.0

            if is_end or is_junction or too_long:
                seg_dist = cum_dists[i] - cum_dists[seg_start_i]
                if seg_dist > 0.5:
                    climb = 0.0
                    descent = 0.0
                    for k in range(seg_start_i, i):
                        dh = elevs[k + 1] - elevs[k]
                        if dh > 0:
                            climb += dh
                        else:
                            descent += -dh

                    u_idx = get_or_add_node(nids[seg_start_i], elevs[seg_start_i])
                    v_idx = get_or_add_node(nid, elevs[i])
                    if u_idx != v_idx:
                        d_int = max(1, int(round(seg_dist)))
                        t_int = max(1, int(round(seg_dist / speed_mps)))
                        c_int = min(65535, int(round(climb)))
                        des_int = min(65535, int(round(descent)))
                        if allow_fwd:
                            edges.append((u_idx, v_idx, d_int, t_int, c_int, des_int, 0))
                        if allow_rev:
                            edges.append((v_idx, u_idx, d_int, t_int, des_int, c_int, 0))
                seg_start_i = i
                last_split_dist = cum_dists[i]

    print(f"      Road graph: {len(node_lats)} nodes, {len(edges)} directed edges in {time.time() - t0:.1f}s")

    # Build KDTree of road nodes for snapping ferries & superchargers
    # Use approximate meters in local Equirectangular / Mercator around lat 35.5 for snapping
    lats_np = np.array(node_lats, dtype=np.float64)
    lons_np = np.array(node_lons, dtype=np.float64)
    cos35 = math.cos(math.radians(35.5))
    node_xy = np.column_stack([lons_np * 111320.0 * cos35, lats_np * 110940.0])
    tree = cKDTree(node_xy)

    def snap_to_road(lat: float, lon: float, max_dist_m: float = 12000.0):
        px = lon * 111320.0 * cos35
        py = lat * 110940.0
        dist_approx, idx = tree.query([px, py])
        true_d = haversine_m(lat, lon, node_lats[idx], node_lons[idx])
        if true_d <= max_dist_m:
            return int(idx), true_d
        return None, true_d

    # Process car ferries
    print("[4/5] Integrating car ferry routes...")
    ferry_list = []
    seen_ferry_pairs = set()
    for tags, raw_nids in ferry_ways:
        coords = [node_coords[nid] for nid in raw_nids if nid in node_coords]
        if len(coords) < 2:
            continue
        total_len = sum(
            haversine_m(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
            for i in range(1, len(coords))
        )
        # Skip tiny harbor shuttles < 400m
        if total_len < 400.0:
            continue

        u_idx, du = snap_to_road(coords[0][0], coords[0][1], max_dist_m=10000.0)
        v_idx, dv = snap_to_road(coords[-1][0], coords[-1][1], max_dist_m=10000.0)
        if u_idx is None or v_idx is None or u_idx == v_idx:
            continue

        pair_key = (min(u_idx, v_idx), max(u_idx, v_idx), round(total_len / 5000))
        if pair_key in seen_ferry_pairs:
            continue
        seen_ferry_pairs.add(pair_key)

        dur_s = parse_duration_seconds(tags.get("duration"))
        if dur_s is None or dur_s < 60:
            # Estimate ~32 km/h (17.3 knots) average including port maneuvering
            dur_s = max(300, int(round(total_len / (32000.0 / 3600.0))))

        name = tags.get("name") or tags.get("name:ja") or tags.get("operator") or "汽车轮渡航线"
        operator = tags.get("operator") or ""
        ev_charge = is_ev_charging_ferry(name, operator)
        flag = 2 if ev_charge else 1

        # Bidirectional ferry edges (dist_m=0 so no driving Wh consumed; only crossing time_s)
        edges.append((u_idx, v_idx, 0, dur_s, 0, 0, flag))
        edges.append((v_idx, u_idx, 0, dur_s, 0, 0, flag))

        # Simplify polyline for map rendering (keep up to ~20 points)
        step = max(1, len(coords) // 18)
        pts = [[round(coords[i][1], 5), round(coords[i][0], 5)] for i in range(0, len(coords), step)]
        if pts[-1] != [round(coords[-1][1], 5), round(coords[-1][0], 5)]:
            pts.append([round(coords[-1][1], 5), round(coords[-1][0], 5)])

        ferry_list.append({
            "name": name,
            "operator": operator,
            "duration_min": round(dur_s / 60),
            "distance_km": round(total_len / 1000.0, 1),
            "ev_charge": ev_charge,
            "u": u_idx,
            "v": v_idx,
            "coords": pts,
        })

    print(f"      Integrated {len(ferry_list)} car ferry routes ({sum(1 for f in ferry_list if f['ev_charge'])} with EV charging)")

    # Build Superchargers JSON
    with open(SC_RAW_PATH, "r", encoding="utf-8") as f:
        sc_raw = json.load(f)

    sc_out = []
    for s in sc_raw:
        if s.get("status") != "OPEN":
            continue
        gps = s.get("gps", {})
        lat = gps.get("latitude")
        lon = gps.get("longitude")
        if lat is None or lon is None:
            continue
        snap_idx, snap_d = snap_to_road(lat, lon, max_dist_m=20000.0)
        if snap_idx is None:
            continue
        addr = s.get("address", {})
        sc_out.append({
            "id": s["id"],
            "name": s.get("name", ""),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "stalls": s.get("stallCount") or 0,
            "kw": s.get("powerKilowatt") or 0,
            "city": addr.get("city") or "",
            "state": addr.get("state") or "",
            "street": addr.get("street") or "",
            "opened": s.get("dateOpened") or "",
            "node": snap_idx,
            "snap_m": int(round(snap_d)),
        })

    print(f"      Snapped {len(sc_out)} OPEN Japan Superchargers to road network")

    # Build Forward CSR + Reverse CSR
    n_nodes = len(node_lats)
    n_edges = len(edges)

    fwd_adj = [[] for _ in range(n_nodes)]
    for e_idx, (u, v, d, t, c, des, flg) in enumerate(edges):
        fwd_adj[u].append((v, d, t, c, des, flg))

    fwd_head = np.zeros(n_nodes + 1, dtype=np.uint32)
    fwd_to = np.zeros(n_edges, dtype=np.uint32)
    fwd_dist = np.zeros(n_edges, dtype=np.uint32)
    fwd_time = np.zeros(n_edges, dtype=np.uint32)
    fwd_climb = np.zeros(n_edges, dtype=np.uint16)
    fwd_descent = np.zeros(n_edges, dtype=np.uint16)
    fwd_flags = np.zeros(n_edges, dtype=np.uint8)

    rev_adj = [[] for _ in range(n_nodes)]
    pos = 0
    for u in range(n_nodes):
        fwd_head[u] = pos
        for v, d, t, c, des, flg in fwd_adj[u]:
            fwd_to[pos] = v
            fwd_dist[pos] = d
            fwd_time[pos] = t
            fwd_climb[pos] = c
            fwd_descent[pos] = des
            fwd_flags[pos] = flg
            rev_adj[v].append((u, pos))
            pos += 1
    fwd_head[n_nodes] = pos

    rev_head = np.zeros(n_nodes + 1, dtype=np.uint32)
    rev_from = np.zeros(n_edges, dtype=np.uint32)
    rev_eidx = np.zeros(n_edges, dtype=np.uint32)
    rpos = 0
    for v in range(n_nodes):
        rev_head[v] = rpos
        for u, e_pos in rev_adj[v]:
            rev_from[rpos] = u
            rev_eidx[rpos] = e_pos
            rpos += 1
    rev_head[n_nodes] = rpos

    graph_path = os.path.join(OUT_DIR, "graph.bin")
    with open(graph_path, "wb") as f:
        f.write(b"DMAP")
        f.write(struct.pack("<II", n_nodes, n_edges))
        f.write(np.array(node_lats, dtype=np.float32).tobytes())
        f.write(np.array(node_lons, dtype=np.float32).tobytes())
        f.write(np.array(node_elevs, dtype=np.int16).tobytes())
        f.write(fwd_head.tobytes())
        f.write(fwd_to.tobytes())
        f.write(fwd_dist.tobytes())
        f.write(fwd_time.tobytes())
        f.write(fwd_climb.tobytes())
        f.write(fwd_descent.tobytes())
        f.write(fwd_flags.tobytes())
        f.write(rev_head.tobytes())
        f.write(rev_from.tobytes())
        f.write(rev_eidx.tobytes())

    with open(os.path.join(OUT_DIR, "superchargers.json"), "w", encoding="utf-8") as f:
        json.dump(sc_out, f, ensure_ascii=False)
    with open(os.path.join(OUT_DIR, "ferries.json"), "w", encoding="utf-8") as f:
        json.dump(ferry_list, f, ensure_ascii=False)

    print(f"      Saved graph.bin ({os.path.getsize(graph_path) / (1024**2):.2f} MB), superchargers.json, ferries.json")
    return lats_np, lons_np, tree


def build_land_grid(lats_np: np.ndarray, lons_np: np.ndarray, tree: cKDTree, elev_sampler: GSIElevationSampler):
    print("[5/5] Building Japan Mercator land grid & road-snap mapping...")
    t0 = time.time()

    merc_y_min = lat_to_merc_y(LAT_MIN)
    merc_y_max = lat_to_merc_y(LAT_MAX)
    lon_span = LON_MAX - LON_MIN
    merc_span_rad = merc_y_max - merc_y_min
    lon_span_rad = math.radians(lon_span)
    grid_h = int(round(GRID_W * (merc_span_rad / lon_span_rad)))

    cos35 = math.cos(math.radians(35.5))

    # Vectorized Mercator pixel -> (lat, lon) -> GSI z9/z8 tile check
    cols = np.arange(GRID_W, dtype=np.float64)
    lons_1d = LON_MIN + (cols + 0.5) / GRID_W * lon_span

    rows = np.arange(grid_h, dtype=np.float64)
    merc_ys_1d = merc_y_max - (rows + 0.5) / grid_h * merc_span_rad
    lats_1d = np.degrees(2.0 * np.arctan(np.exp(merc_ys_1d)) - math.pi / 2.0)

    # Pre-compute GSI z=9 pixel coordinates for every row/col
    n9 = 512 * 256
    px9_1d = np.clip(((lons_1d + 180.0) / 360.0 * n9).astype(np.int32), 0, n9 - 1)
    py9_1d = np.clip(((1.0 - merc_ys_1d / math.pi) / 2.0 * n9).astype(np.int32), 0, n9 - 1)

    n8 = 256 * 256
    px8_1d = np.clip(((lons_1d + 180.0) / 360.0 * n8).astype(np.int32), 0, n8 - 1)
    py8_1d = np.clip(((1.0 - merc_ys_1d / math.pi) / 2.0 * n8).astype(np.int32), 0, n8 - 1)

    land_indices = []
    land_lats = []
    land_lons = []

    for r in range(grid_h):
        ty9 = int(py9_1d[r] >> 8)
        ly9 = int(py9_1d[r] & 255)
        ty8 = int(py8_1d[r] >> 8)
        ly8 = int(py8_1d[r] & 255)
        lat_r = float(lats_1d[r])

        # Group columns by tile x
        c = 0
        while c < GRID_W:
            tx9 = int(px9_1d[c] >> 8)
            c_end = c + 1
            while c_end < GRID_W and int(px9_1d[c_end] >> 8) == tx9:
                c_end += 1

            arr9 = elev_sampler._load_tile(GSI_Z9_DIR, elev_sampler.cache_z9, tx9, ty9)
            if arr9 is not None:
                lxs = px9_1d[c:c_end] & 255
                vals = arr9[ly9, lxs]
                valid_mask = ~np.isnan(vals)
                for offset in np.nonzero(valid_mask)[0]:
                    col_idx = c + int(offset)
                    land_indices.append(r * GRID_W + col_idx)
                    land_lats.append(lat_r)
                    land_lons.append(float(lons_1d[col_idx]))
            else:
                # Try z8 demgm fallback
                for col_idx in range(c, c_end):
                    tx8 = int(px8_1d[col_idx] >> 8)
                    lx8 = int(px8_1d[col_idx] & 255)
                    arr8 = elev_sampler._load_tile(GSI_Z8_GM_DIR, elev_sampler.cache_z8, tx8, ty8)
                    if arr8 is not None and not math.isnan(float(arr8[ly8, lx8])):
                        land_indices.append(r * GRID_W + col_idx)
                        land_lats.append(lat_r)
                        land_lons.append(float(lons_1d[col_idx]))
            c = c_end

    land_lats_np = np.array(land_lats, dtype=np.float64)
    land_lons_np = np.array(land_lons, dtype=np.float64)
    land_xy = np.column_stack([land_lons_np * 111320.0 * cos35, land_lats_np * 110940.0])

    # Query nearest 1 road node for each land pixel
    _, nearest_nodes = tree.query(land_xy)

    # Exact haversine distance from each land pixel to its snapped road node
    n_lats_match = lats_np[nearest_nodes]
    n_lons_match = lons_np[nearest_nodes]
    p1 = np.radians(land_lats_np)
    p2 = np.radians(n_lats_match)
    dp = p2 - p1
    dl = np.radians(n_lons_match - land_lons_np)
    a = np.sin(dp / 2.0) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2.0) ** 2
    true_dists_m = 2.0 * 6371000.0 * np.arcsin(np.minimum(1.0, np.sqrt(a)))

    # Keep land pixels within 45 km of a road node
    keep_mask = true_dists_m <= 45000.0
    kept_pix = np.array(land_indices, dtype=np.uint32)[keep_mask]
    kept_nodes = nearest_nodes[keep_mask].astype(np.uint32)
    kept_dists = np.clip(np.round(true_dists_m[keep_mask]), 0, 65535).astype(np.uint16)

    grid_path = os.path.join(OUT_DIR, "landgrid.bin")
    with open(grid_path, "wb") as f:
        f.write(b"LGRD")
        f.write(struct.pack("<IIIffff", GRID_W, grid_h, len(kept_pix), LAT_MIN, LAT_MAX, LON_MIN, LON_MAX))
        f.write(kept_pix.tobytes())
        f.write(kept_nodes.tobytes())
        f.write(kept_dists.tobytes())

    print(
        f"      Saved landgrid.bin ({os.path.getsize(grid_path) / (1024**2):.2f} MB): "
        f"{len(kept_pix)} land pixels in {GRID_W}x{grid_h} grid ({time.time() - t0:.1f}s)"
    )


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    sampler = GSIElevationSampler()
    roads, ferries, coords = extract_osm_data()
    lats_np, lons_np, kd_tree = build_graph(roads, ferries, coords, sampler)
    build_land_grid(lats_np, lons_np, kd_tree, sampler)
    print("ALL DATA BUILT SUCCESSFULLY!")
