#!/usr/bin/env python3
"""
TeslaMate PostgreSQL -> dokomademap-cn 网页的小接口。

接口（都要带 Authorization: Bearer <BRIDGE_TOKEN>，路径前面可以多一个 /tesla）：
  GET    /status                                 车辆最新电量、位置、近期电耗
  GET    /stats?period=all|YYYY|YYYY-MM          累计/按年/按月总览（里程、充电量、可用年月）
  GET    /drives?limit=20&offset=0&period=...    历史行程分页列表（含简化后的轨迹线）
  GET    /drives/<id>                            单段行程的完整轨迹
  GET    /footprint?period=all|YYYY|YYYY-MM      足迹区域解锁网格、轻量轨迹与去过的县市
  DELETE /drives/<id>                            永久删除一段行程及其轨迹点（不可恢复）
"""

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import time
import psycopg2

DB_HOST = os.environ.get("DATABASE_HOST", "database")
DB_PORT = int(os.environ.get("DATABASE_PORT", "5432"))
DB_NAME = os.environ.get("DATABASE_NAME", "teslamate")
DB_USER = os.environ.get("DATABASE_USER", "teslamate")
DB_PASS = os.environ.get("DATABASE_PASS", "teslamate")
API_TOKEN = os.environ.get("BRIDGE_TOKEN", "")
CAR_ID = int(os.environ.get("CAR_ID", "1"))
LISTEN_PORT = int(os.environ.get("PORT", "8090"))

LIST_PATH_POINTS = 120   # 列表里每段行程最多保留的轨迹点（缩略图与地图总览足够清晰）
DETAIL_PATH_POINTS = 1500  # 单段行程详情最多保留的轨迹点
FOOTPRINT_CELL_LON = 0.02   # 约 1.8 km（日本纬度）
FOOTPRINT_CELL_LAT = 0.018  # 约 2.0 km
FOOTPRINT_CELL_KM2 = 3.6    # 单格估算面积
FOOTPRINT_TRAIL_LIMIT = 150  # 足迹叠加显示的最多行程段数
FOOTPRINT_TRAIL_POINTS = 45  # 足迹每段路线抽稀点数
FOOTPRINT_CACHE_TTL = 120    # 足迹接口内存缓存秒数
JST = timezone(timedelta(hours=9))
_FOOTPRINT_CACHE = {}


def parse_period(period_str):
    """把 period（all / YYYY / YYYY-MM）按日本时间 JST 解析为 UTC 无时区范围 [start, end)。"""
    p = (period_str or "all").strip()
    if not p or p == "all":
        return "all", None, None
    to_utc = lambda dt: dt.astimezone(timezone.utc).replace(tzinfo=None)
    m_yr = re.match(r"^(\d{4})$", p)
    if m_yr:
        y = int(m_yr.group(1))
        return p, to_utc(datetime(y, 1, 1, tzinfo=JST)), to_utc(datetime(y + 1, 1, 1, tzinfo=JST))
    m_ym = re.match(r"^(\d{4})-(\d{2})$", p)
    if m_ym:
        y, mo = int(m_ym.group(1)), int(m_ym.group(2))
        if 1 <= mo <= 12:
            ny, nmo = (y + 1, 1) if mo == 12 else (y, mo + 1)
            return p, to_utc(datetime(y, mo, 1, tzinfo=JST)), to_utc(datetime(ny, nmo, 1, tzinfo=JST))
    return "all", None, None


def period_clause(col, start_dt, end_dt):
    if start_dt is None or end_dt is None:
        return "", []
    return f" AND {col} >= %s AND {col} < %s", [start_dt, end_dt]


def connect():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASS
    )


def downsample(points, limit):
    """均匀抽稀，保证首尾点都在。"""
    n = len(points)
    if n <= limit:
        return points
    step = (n - 1) / (limit - 1)
    return [points[round(i * step)] for i in range(limit)]


def fetch_latest_status():
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.battery_level,
                       COALESCE(p.ideal_battery_range_km, p.rated_battery_range_km),
                       p.latitude,
                       p.longitude,
                       p.date
                FROM positions p
                WHERE p.car_id = %s
                  AND p.battery_level IS NOT NULL
                  AND p.latitude IS NOT NULL
                ORDER BY p.date DESC
                LIMIT 1
                """,
                (CAR_ID,),
            )
            pos = cur.fetchone()

            # 最近 10 段 ≥5 km 的行程，估算平均 Wh/km
            cur.execute(
                """
                SELECT SUM(d.distance), SUM(c.used_energy)
                FROM (
                  SELECT id, distance, start_rated_range_km - end_rated_range_km AS rng
                  FROM drives
                  WHERE car_id = %s AND distance >= 5
                  ORDER BY start_date DESC
                  LIMIT 10
                ) d
                JOIN LATERAL (
                  SELECT GREATEST(0, (MAX(p.battery_level) - MIN(p.battery_level)) * 0.75) AS used_energy
                  FROM positions p
                  WHERE p.drive_id = d.id
                ) c ON true
                """,
                (CAR_ID,),
            )
            drv = cur.fetchone()

        if not pos:
            return {"error": "no position data yet"}

        soc, rng_km, lat, lon, dt = pos
        full_range_km = round(float(rng_km) / (float(soc) / 100.0)) if (rng_km and soc and soc > 5) else 600
        full_range_km = max(400, min(700, full_range_km))

        wh_per_km = 160
        if drv and drv[0] and drv[1] and drv[0] > 10:
            est = (float(drv[1]) * 1000.0) / float(drv[0])
            if 110 <= est <= 250:
                wh_per_km = int(round(est / 5.0) * 5)

        return {
            "soc": int(soc),
            "full_range_km": int(full_range_km),
            "wh_per_km": int(wh_per_km),
            "lat": round(float(lat), 6),
            "lon": round(float(lon), 6),
            "updated_at": dt.isoformat() if dt else None,
        }
    finally:
        conn.close()


PLACE_SQL = """
  COALESCE(
    NULLIF({g}.name, ''),
    NULLIF({a}.name, ''),
    NULLIF(concat_ws(' ', {a}.road, {a}.house_number), ''),
    NULLIF({a}.city, ''),
    {a}.display_name
  )
"""

DRIVE_COLUMNS = f"""
  d.id, d.start_date, d.end_date, d.distance, d.duration_min, d.speed_max,
  (d.start_rated_range_km - d.end_rated_range_km) * c.efficiency AS kwh,
  sp.battery_level, ep.battery_level,
  {PLACE_SQL.format(g="sg", a="sa")} AS from_name,
  {PLACE_SQL.format(g="eg", a="ea")} AS to_name
"""

DRIVE_JOINS = """
  FROM drives d
  JOIN cars c ON c.id = d.car_id
  LEFT JOIN positions sp ON sp.id = d.start_position_id
  LEFT JOIN positions ep ON ep.id = d.end_position_id
  LEFT JOIN addresses sa ON sa.id = d.start_address_id
  LEFT JOIN addresses ea ON ea.id = d.end_address_id
  LEFT JOIN geofences sg ON sg.id = d.start_geofence_id
  LEFT JOIN geofences eg ON eg.id = d.end_geofence_id
"""


def drive_row_to_dict(r):
    (did, start, end, dist, dur, vmax, kwh, soc_s, soc_e, frm, to) = r
    return {
        "id": did,
        "start": start.isoformat() if start else None,
        "end": end.isoformat() if end else None,
        "distance_km": round(float(dist), 1) if dist is not None else None,
        "duration_min": dur,
        "speed_max": vmax,
        "kwh": round(float(kwh), 1) if kwh is not None else None,
        "soc_start": soc_s,
        "soc_end": soc_e,
        "from": frm,
        "to": to,
    }


def fetch_paths(cur, drive_ids, limit):
    if not drive_ids:
        return {}
    cur.execute(
        """
        SELECT drive_id, longitude, latitude
        FROM positions
        WHERE drive_id = ANY(%s) AND latitude IS NOT NULL
        ORDER BY drive_id, date
        """,
        (list(drive_ids),),
    )
    paths = {}
    for did, lon, lat in cur.fetchall():
        paths.setdefault(did, []).append([round(float(lon), 5), round(float(lat), 5)])
    return {k: downsample(v, limit) for k, v in paths.items()}


def fetch_available_periods(cur):
    """查出数据库里有行程或充电记录的所有年月（按日本时间 JST 归类，最新在前）。"""
    cur.execute(
        """
        SELECT DISTINCT to_char(start_date AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS ym
        FROM (
          SELECT start_date FROM drives WHERE car_id = %s AND end_date IS NOT NULL
          UNION ALL
          SELECT start_date FROM charging_processes WHERE car_id = %s AND end_date IS NOT NULL
        ) t
        WHERE start_date IS NOT NULL
        ORDER BY ym DESC
        """,
        (CAR_ID, CAR_ID),
    )
    months = [r[0] for r in cur.fetchall() if r[0]]
    years = sorted({m[:4] for m in months}, reverse=True)
    return {"years": years, "months": months}


def fetch_stats(period_str="all"):
    """汇总累计或指定年/月的里程、行程数、时长与充电量，并返回可用年月列表。"""
    period, start_dt, end_dt = parse_period(period_str)
    d_sql, d_args = period_clause("d.start_date", start_dt, end_dt)
    c_sql, c_args = period_clause("start_date", start_dt, end_dt)
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT
                  COUNT(*),
                  COALESCE(SUM(d.distance), 0),
                  COALESCE(SUM(d.duration_min), 0),
                  COALESCE(SUM(GREATEST(0, (d.start_rated_range_km - d.end_rated_range_km) * c.efficiency)), 0),
                  MIN(d.start_date),
                  COALESCE(MAX(d.distance), 0)
                FROM drives d
                JOIN cars c ON c.id = d.car_id
                WHERE d.car_id = %s AND d.end_date IS NOT NULL {d_sql}
                """,
                [CAR_ID] + d_args,
            )
            drv = cur.fetchone() or (0, 0, 0, 0, None, 0)

            cur.execute(
                f"""
                SELECT
                  COUNT(*),
                  COALESCE(SUM(charge_energy_added), 0),
                  COALESCE(SUM(COALESCE(charge_energy_used, charge_energy_added)), 0),
                  MIN(start_date)
                FROM charging_processes
                WHERE car_id = %s AND end_date IS NOT NULL {c_sql}
                """,
                [CAR_ID] + c_args,
            )
            chg = cur.fetchone() or (0, 0, 0, None)
            periods = fetch_available_periods(cur)

        dates = [dt for dt in (drv[4], chg[3]) if dt is not None]
        since = min(dates).isoformat() if dates else None

        return {
            "period": period,
            "periods": periods,
            "since": since,
            "drive_count": int(drv[0] or 0),
            "total_distance_km": round(float(drv[1] or 0), 1),
            "total_duration_min": int(drv[2] or 0),
            "total_drive_kwh": round(float(drv[3] or 0), 1),
            "max_drive_km": round(float(drv[5] or 0), 1),
            "charge_count": int(chg[0] or 0),
            "total_charge_kwh": round(float(chg[1] or 0), 1),
            "total_charge_used_kwh": round(float(chg[2] or 0), 1),
        }
    finally:
        conn.close()


def fetch_drives(limit, offset=0, period_str="all"):
    limit = max(1, min(50, limit))
    offset = max(0, offset)
    period, start_dt, end_dt = parse_period(period_str)
    d_sql, d_args = period_clause("d.start_date", start_dt, end_dt)
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT COUNT(*) FROM drives d WHERE d.car_id = %s AND d.end_date IS NOT NULL {d_sql}",
                [CAR_ID] + d_args,
            )
            total = int((cur.fetchone() or (0,))[0] or 0)
            cur.execute(
                f"SELECT {DRIVE_COLUMNS} {DRIVE_JOINS} "
                f"WHERE d.car_id = %s AND d.end_date IS NOT NULL {d_sql} "
                "ORDER BY d.start_date DESC LIMIT %s OFFSET %s",
                [CAR_ID] + d_args + [limit, offset],
            )
            drives = [drive_row_to_dict(r) for r in cur.fetchall()]
            paths = fetch_paths(cur, [d["id"] for d in drives], LIST_PATH_POINTS)
        for d in drives:
            d["path"] = paths.get(d["id"], [])
        return {
            "period": period,
            "drives": drives,
            "total": total,
            "offset": offset,
            "limit": limit,
            "has_more": (offset + len(drives)) < total,
        }
    finally:
        conn.close()


def fetch_footprint(period_str="all"):
    """按约 2km 网格聚合已探索区域，并返回轻量轨迹线与去过的县/市。"""
    period, start_dt, end_dt = parse_period(period_str)
    now = time.time()
    cached = _FOOTPRINT_CACHE.get(period)
    if cached and (now - cached[0]) < FOOTPRINT_CACHE_TTL:
        return cached[1]

    p_sql, p_args = period_clause("p.date", start_dt, end_dt)
    d_sql, d_args = period_clause("d.start_date", start_dt, end_dt)
    conn = connect()
    try:
        with conn.cursor() as cur:
            # 1) 数据库端按网格聚合所有行车定位点（毫秒级）
            cur.execute(
                f"""
                SELECT
                  FLOOR(p.longitude / %s)::int AS gx,
                  FLOOR(p.latitude / %s)::int AS gy,
                  COUNT(DISTINCT COALESCE(p.drive_id, 0)) AS visits
                FROM positions p
                WHERE p.car_id = %s
                  AND p.latitude IS NOT NULL
                  AND p.longitude IS NOT NULL
                  AND p.drive_id IS NOT NULL
                  {p_sql}
                GROUP BY gx, gy
                """,
                [FOOTPRINT_CELL_LON, FOOTPRINT_CELL_LAT, CAR_ID] + p_args,
            )
            cells = [[int(gx), int(gy), int(v)] for gx, gy, v in cur.fetchall()]

            # 2) 行程统计与最近 N 段轻量轨迹
            cur.execute(
                f"""
                SELECT COUNT(*), COALESCE(SUM(d.distance), 0)
                FROM drives d
                WHERE d.car_id = %s AND d.end_date IS NOT NULL {d_sql}
                """,
                [CAR_ID] + d_args,
            )
            drv_cnt, drv_km = cur.fetchone() or (0, 0)

            cur.execute(
                f"""
                SELECT d.id
                FROM drives d
                WHERE d.car_id = %s AND d.end_date IS NOT NULL {d_sql}
                ORDER BY d.start_date DESC
                LIMIT %s
                """,
                [CAR_ID] + d_args + [FOOTPRINT_TRAIL_LIMIT],
            )
            trail_ids = [r[0] for r in cur.fetchall()]
            trail_map = fetch_paths(cur, trail_ids, FOOTPRINT_TRAIL_POINTS)
            trails = [trail_map[i] for i in trail_ids if len(trail_map.get(i, [])) >= 2]

            # 3) 去过的都道府县与市区（来自起终点地址）
            cur.execute(
                f"""
                SELECT DISTINCT
                  NULLIF(TRIM(a.state), ''),
                  NULLIF(TRIM(COALESCE(NULLIF(a.city, ''), a.county)), '')
                FROM drives d
                JOIN addresses a ON a.id IN (d.start_address_id, d.end_address_id)
                WHERE d.car_id = %s AND d.end_date IS NOT NULL {d_sql}
                """,
                [CAR_ID] + d_args,
            )
            prefs = sorted({r[0] for r in cur.fetchall() if r[0]})
            cur.execute(
                f"""
                SELECT DISTINCT
                  NULLIF(TRIM(COALESCE(NULLIF(a.city, ''), a.county)), '')
                FROM drives d
                JOIN addresses a ON a.id IN (d.start_address_id, d.end_address_id)
                WHERE d.car_id = %s AND d.end_date IS NOT NULL {d_sql}
                """,
                [CAR_ID] + d_args,
            )
            cities = sorted({r[0] for r in cur.fetchall() if r[0]})
            periods = fetch_available_periods(cur)

        bounds = None
        if cells:
            min_gx = min(c[0] for c in cells)
            max_gx = max(c[0] for c in cells)
            min_gy = min(c[1] for c in cells)
            max_gy = max(c[1] for c in cells)
            bounds = [
                round(min_gx * FOOTPRINT_CELL_LON, 5),
                round(min_gy * FOOTPRINT_CELL_LAT, 5),
                round((max_gx + 1) * FOOTPRINT_CELL_LON, 5),
                round((max_gy + 1) * FOOTPRINT_CELL_LAT, 5),
            ]

        result = {
            "period": period,
            "periods": periods,
            "cell_size": [FOOTPRINT_CELL_LON, FOOTPRINT_CELL_LAT],
            "cells": cells,
            "cell_count": len(cells),
            "area_km2": round(len(cells) * FOOTPRINT_CELL_KM2, 1),
            "drive_count": int(drv_cnt or 0),
            "total_distance_km": round(float(drv_km or 0), 1),
            "prefectures": prefs,
            "cities": cities,
            "trails": trails,
            "bounds": bounds,
        }
        _FOOTPRINT_CACHE[period] = (now, result)
        return result
    finally:
        conn.close()


def fetch_drive(drive_id):
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {DRIVE_COLUMNS} {DRIVE_JOINS} WHERE d.car_id = %s AND d.id = %s",
                (CAR_ID, drive_id),
            )
            row = cur.fetchone()
            if not row:
                return None
            drive = drive_row_to_dict(row)
            drive["path"] = fetch_paths(cur, [drive_id], DETAIL_PATH_POINTS).get(drive_id, [])
        return drive
    finally:
        conn.close()


def delete_drive(drive_id):
    """永久删除一段已结束的行程：先删轨迹点，再删行程本身，同一个事务里完成。"""
    conn = connect()
    try:
        with conn:  # 出错自动回滚
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM drives WHERE id = %s AND car_id = %s AND end_date IS NOT NULL FOR UPDATE",
                    (drive_id, CAR_ID),
                )
                if not cur.fetchone():
                    return False
                cur.execute(
                    "DELETE FROM positions WHERE drive_id = %s AND car_id = %s",
                    (drive_id, CAR_ID),
                )
                cur.execute("DELETE FROM drives WHERE id = %s AND car_id = %s", (drive_id, CAR_ID))
        _FOOTPRINT_CACHE.clear()
        return True
    finally:
        conn.close()


DRIVE_ID_RE = re.compile(r"^/drives/(\d+)$")


class Handler(BaseHTTPRequestHandler):
    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS")

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)

    def _route(self):
        path, _, query = self.path.partition("?")
        if path.startswith("/tesla/"):
            path = path[len("/tesla"):]
        params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
        return path.rstrip("/") or "/", params

    def _authorized(self):
        if not API_TOKEN:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {API_TOKEN}"

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        path, params = self._route()
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        try:
            if path == "/status":
                return self._json(200, fetch_latest_status())
            if path == "/stats":
                return self._json(200, fetch_stats(params.get("period", "all")))
            if path == "/footprint":
                return self._json(200, fetch_footprint(params.get("period", "all")))
            if path == "/drives":
                try:
                    limit = int(params.get("limit", "20"))
                except ValueError:
                    limit = 20
                try:
                    offset = int(params.get("offset", "0"))
                except ValueError:
                    offset = 0
                return self._json(200, fetch_drives(limit, offset, params.get("period", "all")))
            m = DRIVE_ID_RE.match(path)
            if m:
                drive = fetch_drive(int(m.group(1)))
                return self._json(200, drive) if drive else self._json(404, {"error": "not found"})
            return self._json(404, {"error": "not found"})
        except Exception as e:
            return self._json(500, {"error": str(e)})

    def do_DELETE(self):
        path, _ = self._route()
        # 删除会改动数据库，必须设置了 BRIDGE_TOKEN 才允许
        if not API_TOKEN:
            return self._json(403, {"error": "BRIDGE_TOKEN not set; delete disabled"})
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        m = DRIVE_ID_RE.match(path)
        if not m:
            return self._json(404, {"error": "not found"})
        try:
            ok = delete_drive(int(m.group(1)))
            return self._json(200, {"deleted": int(m.group(1))}) if ok else self._json(404, {"error": "not found"})
        except Exception as e:
            return self._json(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"TeslaMate bridge listening on :{LISTEN_PORT}")
    ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler).serve_forever()
