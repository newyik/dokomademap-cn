#!/usr/bin/env python3
"""
Read-only status bridge for TeslaMate PostgreSQL -> dokomademap-cn web UI.
Exposes GET /status protected by Bearer token with CORS enabled.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import psycopg2

DB_HOST = os.environ.get("DATABASE_HOST", "database")
DB_PORT = int(os.environ.get("DATABASE_PORT", "5432"))
DB_NAME = os.environ.get("DATABASE_NAME", "teslamate")
DB_USER = os.environ.get("DATABASE_USER", "teslamate")
DB_PASS = os.environ.get("DATABASE_PASS", "teslamate")
API_TOKEN = os.environ.get("BRIDGE_TOKEN", "")
CAR_ID = int(os.environ.get("CAR_ID", "1"))
LISTEN_PORT = int(os.environ.get("PORT", "8090"))


def fetch_latest_status():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASS
    )
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

            # Compute recent average Wh/km from last 10 drives >= 5 km
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


class Handler(BaseHTTPRequestHandler):
    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] not in ("/status", "/tesla/status"):
            self.send_response(404)
            self._send_cors()
            self.end_headers()
            return

        if API_TOKEN:
            auth = self.headers.get("Authorization", "")
            if auth != f"Bearer {API_TOKEN}":
                self.send_response(401)
                self._send_cors()
                self.end_headers()
                self.wfile.write(b'{"error":"unauthorized"}')
                return

        try:
            payload = fetch_latest_status()
            body = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._send_cors()
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(500)
            self._send_cors()
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"TeslaMate read-only bridge listening on :{LISTEN_PORT}")
    ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler).serve_forever()
