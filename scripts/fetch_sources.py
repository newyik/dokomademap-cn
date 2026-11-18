#!/usr/bin/env python3
"""
Fetch completely public upstream data sources for Japan EV reachability map:
1. Tesla Superchargers in Japan from supercharge.info public API
2. OpenStreetMap Japan extract from Geofabrik (japan-latest.osm.pbf)
3. Geospatial Information Authority of Japan (GSI / 国土地理院) DEM PNG tiles (z=9, plus z=8 demgm fallback)
"""

import concurrent.futures
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(BASE_DIR, "raw_cache")
GSI_Z9_DIR = os.path.join(RAW_DIR, "gsi_z9")
GSI_Z8_GM_DIR = os.path.join(RAW_DIR, "gsi_z8_gm")

USER_AGENT = "DokomadeMapCN/1.0 (Personal EV Reachability Map Builder)"
PBF_URL = "https://download.geofabrik.de/asia/japan-latest.osm.pbf"
SC_URL = "https://supercharge.info/service/supercharge/allSites"

# Japan geographic bounding box (includes Okinawa & Hokkaido)
LAT_MIN, LAT_MAX = 24.0, 45.8
LON_MIN, LON_MAX = 122.8, 145.9


def ensure_dirs():
    os.makedirs(RAW_DIR, exist_ok=True)
    os.makedirs(GSI_Z9_DIR, exist_ok=True)
    os.makedirs(GSI_Z8_GM_DIR, exist_ok=True)


def fetch_superchargers():
    out_path = os.path.join(RAW_DIR, "superchargers_raw.json")
    print("[1/3] Fetching supercharge.info allSites...")
    req = urllib.request.Request(SC_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        sites = json.loads(resp.read().decode("utf-8"))

    jp_sites = [
        s for s in sites
        if s.get("address", {}).get("country") == "Japan"
    ]
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(jp_sites, f, ensure_ascii=False, indent=2)
    open_cnt = sum(1 for s in jp_sites if s.get("status") == "OPEN")
    print(f"      Saved {len(jp_sites)} Japan sites ({open_cnt} OPEN) -> {out_path}")


def deg2tile(lat_deg: float, lon_deg: float, zoom: int) -> tuple[int, int]:
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return xtile, ytile


def download_tile(url: str, dst: str) -> str:
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return "cached"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = r.read()
        with open(dst, "wb") as f:
            f.write(data)
        return "ok"
    except urllib.error.HTTPError as e:
        if e.code == 404:
            # Create zero-byte sentinel for ocean/empty tiles so we don't re-request
            with open(dst, "wb") as f:
                pass
            return "404"
        return f"err:{e.code}"
    except Exception as e:
        return f"err:{e}"


def fetch_gsi_tiles():
    print("[2/3] Fetching GSI DEM tiles (dem_png z=9 + demgm_png z=8)...")
    x0, y1 = deg2tile(LAT_MIN, LON_MIN, 9)
    x1, y0 = deg2tile(LAT_MAX, LON_MAX, 9)
    tasks_z9 = []
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            url = f"https://cyberjapandata.gsi.go.jp/xyz/dem_png/9/{x}/{y}.png"
            dst = os.path.join(GSI_Z9_DIR, f"{x}_{y}.png")
            tasks_z9.append((url, dst))

    x0_8, y1_8 = deg2tile(LAT_MIN, LON_MIN, 8)
    x1_8, y0_8 = deg2tile(LAT_MAX, LON_MAX, 8)
    tasks_z8 = []
    for x in range(x0_8, x1_8 + 1):
        for y in range(y0_8, y1_8 + 1):
            url = f"https://cyberjapandata.gsi.go.jp/xyz/demgm_png/8/{x}/{y}.png"
            dst = os.path.join(GSI_Z8_GM_DIR, f"{x}_{y}.png")
            tasks_z8.append((url, dst))

    all_tasks = tasks_z9 + tasks_z8
    stats = {"ok": 0, "cached": 0, "404": 0, "err": 0}
    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        for res in ex.map(lambda args: download_tile(*args), all_tasks):
            if res in stats:
                stats[res] += 1
            else:
                stats["err"] += 1
    print(f"      GSI tiles done in {time.time() - t0:.1f}s: {stats} (total {len(all_tasks)})")


def fetch_pbf_parallel():
    out_path = os.path.join(RAW_DIR, "japan-latest.osm.pbf")
    req = urllib.request.Request(PBF_URL, method="HEAD", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as r:
        total_size = int(r.headers["Content-Length"])

    if os.path.exists(out_path) and os.path.getsize(out_path) == total_size:
        print(f"[3/3] PBF already complete ({total_size / (1024**2):.1f} MB) -> {out_path}")
        return

    print(f"[3/3] Downloading japan-latest.osm.pbf ({total_size / (1024**2):.1f} MB) using 6 parallel range parts...")
    num_parts = 6
    part_size = math.ceil(total_size / num_parts)
    part_paths = [f"{out_path}.part{i}" for i in range(num_parts)]

    def download_part(idx: int):
        start = idx * part_size
        end = min(total_size - 1, (idx + 1) * part_size - 1)
        expected = end - start + 1
        pp = part_paths[idx]
        existing = os.path.getsize(pp) if os.path.exists(pp) else 0
        if existing == expected:
            return idx, expected
        cur_start = start + existing
        mode = "ab" if existing > 0 and existing < expected else "wb"
        if existing > expected:
            cur_start = start
            mode = "wb"

        for attempt in range(5):
            try:
                cur_have = os.path.getsize(pp) if (mode == "ab" and os.path.exists(pp)) else 0
                req_start = start + cur_have
                if req_start > end:
                    return idx, expected
                r_req = urllib.request.Request(
                    PBF_URL,
                    headers={"User-Agent": USER_AGENT, "Range": f"bytes={req_start}-{end}"},
                )
                with urllib.request.urlopen(r_req, timeout=60) as resp, open(pp, "ab" if cur_have > 0 else "wb") as f:
                    while True:
                        chunk = resp.read(262144)
                        if not chunk:
                            break
                        f.write(chunk)
                if os.path.getsize(pp) == expected:
                    return idx, expected
            except Exception as e:
                print(f"      Part {idx} attempt {attempt + 1} error: {e}", flush=True)
                time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"Failed to download part {idx} completely")

    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=num_parts) as ex:
        futures = [ex.submit(download_part, i) for i in range(num_parts)]
        for fut in concurrent.futures.as_completed(futures):
            idx, sz = fut.result()
            print(f"      Part {idx} complete ({sz / (1024**2):.1f} MB)", flush=True)

    print("      Merging parts into japan-latest.osm.pbf...", flush=True)
    tmp_out = out_path + ".tmp"
    with open(tmp_out, "wb") as out_f:
        for pp in part_paths:
            with open(pp, "rb") as pf:
                while True:
                    buf = pf.read(4 * 1024 * 1024)
                    if not buf:
                        break
                    out_f.write(buf)
    os.replace(tmp_out, out_path)
    for pp in part_paths:
        os.remove(pp)
    dt = time.time() - t0
    print(f"      PBF ready in {dt:.1f}s ({total_size / (1024**2) / dt:.2f} MB/s)")


if __name__ == "__main__":
    ensure_dirs()
    only = set(sys.argv[1:])
    if not only or "sc" in only:
        fetch_superchargers()
    if not only or "gsi" in only:
        fetch_gsi_tiles()
    if not only or "pbf" in only:
        fetch_pbf_parallel()
