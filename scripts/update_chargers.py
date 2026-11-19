#!/usr/bin/env python3
"""
Lightweight updater for Japan Tesla Superchargers (supercharge.info) using the
existing road network in public/data/graph.bin (no 2.4GB PBF needed).
Designed to run fast locally or in weekly GitHub Actions cron sync.
"""

from collections import deque
import json
import math
import os
import struct
import urllib.request

import numpy as np
from scipy.spatial import cKDTree

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "public", "data")
SC_URL = "https://supercharge.info/service/supercharge/allSites"
USER_AGENT = "DokomadeMapCN/1.0"


def load_graph_connectivity():
    buf = open(os.path.join(DATA_DIR, "graph.bin"), "rb").read()
    n, m = struct.unpack_from("<II", buf, 4)

    off_lat = 12
    off_lon = off_lat + n * 4
    off_elev = off_lon + n * 4
    off_head = off_elev + n * 2
    off_to = off_head + (n + 1) * 4
    off_dist = off_to + m * 4
    off_time = off_dist + m * 4
    off_climb = off_time + m * 4
    off_desc = off_climb + m * 2
    off_flg = off_desc + m * 2
    off_rev_head = off_flg + m
    off_rev_from = off_rev_head + (n + 1) * 4

    lat = np.frombuffer(buf, dtype=np.float32, count=n, offset=off_lat).copy()
    lon = np.frombuffer(buf, dtype=np.float32, count=n, offset=off_lon).copy()
    head = np.frombuffer(buf, dtype=np.uint32, count=n + 1, offset=off_head)
    to = np.frombuffer(buf, dtype=np.uint32, count=m, offset=off_to)
    flg = np.frombuffer(buf, dtype=np.uint8, count=m, offset=off_flg)
    rev_head = np.frombuffer(buf, dtype=np.uint32, count=n + 1, offset=off_rev_head)
    rev_from = np.frombuffer(buf, dtype=np.uint32, count=m, offset=off_rev_from)

    cos35 = math.cos(math.radians(35.5))
    tree = cKDTree(np.column_stack([lon * 111320.0 * cos35, lat * 110940.0]))

    def bfs_bidir(start_node: int):
        fwd = bytearray(n)
        fwd[start_node] = 1
        q = deque([start_node])
        while q:
            u = q.popleft()
            for k in range(head[u], head[u + 1]):
                if flg[k]:
                    continue
                v = int(to[k])
                if not fwd[v]:
                    fwd[v] = 1
                    q.append(v)
        bwd = bytearray(n)
        bwd[start_node] = 1
        q = deque([start_node])
        while q:
            v = q.popleft()
            for k in range(rev_head[v], rev_head[v + 1]):
                u = int(rev_from[k])
                if not bwd[u]:
                    bwd[u] = 1
                    q.append(u)
        return np.frombuffer(fwd, dtype=np.uint8) & np.frombuffer(bwd, dtype=np.uint8)

    # Known hub coordinates: Tokyo Setagaya, Sapporo, Naha
    hubs = [(35.635, 139.615), (43.061, 141.354), (26.225, 127.685)]
    valid_main = np.zeros(n, dtype=np.uint8)
    for h_lat, h_lon in hubs:
        _, idx = tree.query([h_lon * 111320.0 * cos35, h_lat * 110940.0])
        valid_main |= bfs_bidir(int(idx))

    return lat, lon, tree, valid_main, cos35


def main():
    print("Fetching supercharge.info allSites...")
    req = urllib.request.Request(SC_URL, headers={"User-Agent": USER_AGENT})
    sites = json.loads(urllib.request.urlopen(req, timeout=30).read().decode("utf-8"))
    jp_open = [
        s for s in sites
        if s.get("address", {}).get("country") == "Japan" and s.get("status") == "OPEN"
    ]
    print(f"Found {len(jp_open)} OPEN Japan Superchargers; loading road graph...")

    lat, lon, tree, valid_main, cos35 = load_graph_connectivity()

    out = []
    for s in jp_open:
        gps = s.get("gps", {})
        s_lat = gps.get("latitude")
        s_lon = gps.get("longitude")
        if s_lat is None or s_lon is None:
            continue
        px = s_lon * 111320.0 * cos35
        py = s_lat * 110940.0
        dists, idxs = tree.query([px, py], k=40)
        chosen_idx = None
        chosen_d = None
        for d, idx in zip(dists, idxs):
            idx = int(idx)
            if d > 20000.0:
                break
            if valid_main[idx]:
                chosen_idx = idx
                chosen_d = float(d)
                break
        if chosen_idx is None and dists[0] <= 20000.0:
            chosen_idx = int(idxs[0])
            chosen_d = float(dists[0])
        if chosen_idx is None:
            continue

        addr = s.get("address", {})
        out.append({
            "id": s["id"],
            "name": s.get("name", ""),
            "lat": round(float(s_lat), 6),
            "lon": round(float(s_lon), 6),
            "stalls": s.get("stallCount") or 0,
            "kw": s.get("powerKilowatt") or 0,
            "city": addr.get("city") or "",
            "state": addr.get("state") or "",
            "street": addr.get("street") or "",
            "opened": s.get("dateOpened") or "",
            "node": chosen_idx,
            "snap_m": int(round(chosen_d)),
        })

    out_path = os.path.join(DATA_DIR, "superchargers.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"Updated {len(out)} Superchargers -> {out_path}")


if __name__ == "__main__":
    main()
