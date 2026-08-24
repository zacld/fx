"""
api/run.py — Vercel Python function: GET/POST /api/run

Serverless constraint vs. server.py's Fly.io design: no persistent background
thread or in-memory state across invocations, so there's no /status polling
here. POST runs the pipeline synchronously within the request and returns
the CSV directly. Keep runs small (tier1_only, or a low max_per_sic) to stay
inside the function's execution time limit — see vercel.json's maxDuration.
"""

import csv
import io
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

# api/ is a subdirectory of the project root where main.py and sourcer/ live —
# Vercel's Python runtime doesn't guarantee the project root is on sys.path.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main as pipeline  # noqa: E402


def _rows_to_csv_bytes(rows: list[dict]) -> bytes:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=pipeline.CSV_FIELDS)
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue().encode()


class handler(BaseHTTPRequestHandler):
    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        self._json(200, {
            "usage": "POST /api/run with an optional JSON body "
                     "{\"tier1_only\": bool, \"tier2_only\": bool, \"max_per_sic\": int}. "
                     "Runs synchronously and returns the CSV directly (serverless — "
                     "no background /status here, unlike the Fly.io server.py deployment). "
                     "Keep runs small to stay inside the function's execution time limit.",
        })

    def do_POST(self) -> None:
        required_token = os.environ.get("TRIGGER_TOKEN", "").strip()
        if required_token and self.headers.get("X-Trigger-Token", "") != required_token:
            self._json(401, {"error": "missing or invalid X-Trigger-Token header"})
            return

        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid JSON body"})
            return

        tier1_only = bool(body.get("tier1_only", False))
        tier2_only = bool(body.get("tier2_only", False))
        max_per_sic = body.get("max_per_sic")

        if tier1_only and tier2_only:
            self._json(400, {"error": "tier1_only and tier2_only are mutually exclusive"})
            return

        try:
            rows = pipeline.run_pipeline(tier1_only=tier1_only, tier2_only=tier2_only, max_per_sic=max_per_sic)
        except (ValueError, FileNotFoundError) as e:
            self._json(400, {"error": str(e)})
            return
        except Exception as e:  # noqa: BLE001 — never leak a raw 500 with no explanation
            self._json(500, {"error": f"pipeline run failed: {e}"})
            return

        csv_bytes = _rows_to_csv_bytes(rows)
        self.send_response(200)
        self.send_header("Content-Type", "text/csv")
        self.send_header("Content-Disposition", 'attachment; filename="hayvin_leads.csv"')
        self.send_header("Content-Length", str(len(csv_bytes)))
        self.end_headers()
        self.wfile.write(csv_bytes)
