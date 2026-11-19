#!/usr/bin/env python3
"""
TeslaMate PostgreSQL -> dokomademap-cn 网页的小接口。

接口（都要带 Authorization: Bearer <BRIDGE_TOKEN>，路径前面可以多一个 /tesla）：
  GET    /status              车辆最新电量、位置、近期电耗
  GET    /drives?limit=20     最近的行程列表（含简化后的轨迹线）
  GET    /drives/<id>         单段行程的完整轨迹
  DELETE /drives/<id>         永久删除一段行程及其轨迹点（不可恢复）
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import psycopg2

DB_HOST = os.environ.get("DATABASE_HOST", "database")
DB_PORT = int(os.environ.get("DATABASE_PORT", "5432"))
DB_NAME = os.environ.get("DATABASE_NAME", "teslamate")
DB_USER = os.environ.get("DATABASE_USER", "teslamate")
DB_PASS = os.environ.get("DATABASE_PASS", "teslamate")
API_TOKEN = os.environ.get("BRIDGE_TOKEN", "")
CAR_ID = int(os.environ.get("CAR_ID", "1"))
LISTEN_PORT = int(os.environ.get("PORT", "8090"))

LIST_PATH_POINTS = 180   # 列表里每段行程最多保留的轨迹点
DETAIL_PATH_POINTS = 1500  # 单段行程详情最多保留的轨迹点


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


def fetch_drives(limit):
    limit = max(1, min(50, limit))
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {DRIVE_COLUMNS} {DRIVE_JOINS} "
                "WHERE d.car_id = %s AND d.end_date IS NOT NULL "
                "ORDER BY d.start_date DESC LIMIT %s",
                (CAR_ID, limit),
            )
            drives = [drive_row_to_dict(r) for r in cur.fetchall()]
            paths = fetch_paths(cur, [d["id"] for d in drives], LIST_PATH_POINTS)
        for d in drives:
            d["path"] = paths.get(d["id"], [])
        return {"drives": drives}
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
            if path == "/drives":
                try:
                    limit = int(params.get("limit", "20"))
                except ValueError:
                    limit = 20
                return self._json(200, fetch_drives(limit))
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
