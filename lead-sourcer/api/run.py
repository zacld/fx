"""
api/run.py — Vercel Python function: GET/POST /api/run

Serverless constraint vs. server.py's Fly.io design: no persistent background
thread or in-memory state across invocations, so there's no /status polling
here. POST runs the finder synchronously within the request and returns the
CSV directly. It uses the Companies House search API (a capped sample per
SIC code — the ~470MB bulk file is out of reach of a serverless request),
and a run must name its niches to fit inside the function's time limit
(see vercel.json's maxDuration). For every company in a niche, use the CLI
or server.py with the bulk file.
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

# Lower than the CLI default: every company found costs Companies House calls
# at 0.5s apiece, and the whole run has to finish inside one request.
SERVERLESS_DEFAULT_MAX_PER_SIC = 10


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
            "usage": "POST /api/run with a JSON body {\"niches\": [id, ...]} (required), plus optional "
                     "\"min_turnover\": int, \"turnover_check\": bool, \"max_enrich\": int, \"max_per_sic\": int. "
                     "Runs synchronously and returns the CSV directly. Searches a sample of "
                     f"{SERVERLESS_DEFAULT_MAX_PER_SIC} companies per SIC code by default; for every company "
                     "in a niche, run the CLI or server.py with the bulk file.",
            "niches": pipeline.niche_summaries(),
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

        try:
            options = pipeline.options_from_request(body)
        except ValueError as e:
            self._json(400, {"error": str(e)})
            return
        if not options["niche_ids"]:
            self._json(400, {"error": "name the niches to search (\"niches\": [id, ...] — GET /api/run lists them). "
                                      "Every niche won't finish inside a serverless request; run that via the CLI "
                                      "or server.py."})
            return
        options["max_per_sic"] = options["max_per_sic"] or SERVERLESS_DEFAULT_MAX_PER_SIC

        try:
            rows = pipeline.run_pipeline(**options, source="api")
        except (ValueError, FileNotFoundError) as e:
            self._json(400, {"error": str(e)})
            return
        except Exception as e:  # noqa: BLE001 — never leak a raw 500 with no explanation
            self._json(500, {"error": f"pipeline run failed: {e}"})
            return

        csv_bytes = _rows_to_csv_bytes(rows)
        self.send_response(200)
        self.send_header("Content-Type", "text/csv")
        self.send_header("Content-Disposition", 'attachment; filename="fx_companies.csv"')
        self.send_header("Content-Length", str(len(csv_bytes)))
        self.end_headers()
        self.wfile.write(csv_bytes)
