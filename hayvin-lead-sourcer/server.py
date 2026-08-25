#!/usr/bin/env python3
"""
server.py — thin HTTP wrapper around main.py's pipeline, for deployment as a
live URL (e.g. Fly.io, matching the pattern of the rest of this repo).

stdlib-only (http.server) — no new dependency for the web layer itself.

Endpoints:
  GET  /health           -> {"status": "ok"}
  GET  /status            -> current/last run status (idle | running | done | error)
  POST /run               -> kick off a pipeline run in the background.
                              Optional JSON body: {"tier1_only": bool, "tier2_only": bool,
                                                    "max_per_sic": int}
                              Returns 202 immediately; poll /status for progress.
                              Returns 409 if a run is already in progress.
  GET  /leads.csv          -> the most recently completed run's CSV (404 if none yet)

Runs are triggered on demand rather than continuously — this pipeline makes
real, quota-limited third-party API calls (Companies House, Hunter.io), so
nothing here polls or auto-runs on a schedule.

If TRIGGER_TOKEN is set, POST /run requires a matching `X-Trigger-Token`
header — this guards against a public URL silently burning your API quota.
Without it, /run is open to anyone who can reach the URL (fine for a
private/internal deployment, not recommended for a public one).
"""

from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

import main as pipeline

OUTPUT_DIR = os.environ.get("HAYVIN_OUTPUT_DIR", "output")
OUTPUT_PATH = os.path.join(OUTPUT_DIR, "hayvin_leads.csv")

_lock = threading.Lock()
_state: dict = {
    "status": "idle",  # idle | running | done | error
    "started_at": None,
    "finished_at": None,
    "row_count": None,
    "error": None,
}


def _run_in_background(tier1_only: bool, tier2_only: bool, max_per_sic: Optional[int]) -> None:
    global _state
    try:
        rows = pipeline.run_pipeline(tier1_only=tier1_only, tier2_only=tier2_only, max_per_sic=max_per_sic)
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        pipeline.write_csv(rows, OUTPUT_PATH)
        with _lock:
            _state.update(
                status="done",
                finished_at=datetime.now(timezone.utc).isoformat(),
                row_count=len(rows),
                error=None,
            )
    except Exception as e:  # noqa: BLE001 — surface any failure via /status, don't kill the server
        traceback.print_exc()
        with _lock:
            _state.update(
                status="error",
                finished_at=datetime.now(timezone.utc).isoformat(),
                error=str(e),
            )


class Handler(BaseHTTPRequestHandler):
    server_version = "HayvinLeadSourcer/1.0"

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:  # quieter default access log
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"status": "ok"})
            return

        if self.path == "/status":
            with _lock:
                self._json(200, dict(_state))
            return

        if self.path == "/leads.csv":
            if not os.path.exists(OUTPUT_PATH):
                self._json(404, {"error": "no completed run yet — POST /run first"})
                return
            with open(OUTPUT_PATH, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/csv")
            self.send_header("Content-Disposition", 'attachment; filename="hayvin_leads.csv"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self._json(404, {"error": "not found", "routes": ["/health", "/status", "/leads.csv", "POST /run"]})

    def do_POST(self) -> None:
        if self.path != "/run":
            self._json(404, {"error": "not found"})
            return

        required_token = os.environ.get("TRIGGER_TOKEN", "").strip()
        if required_token and self.headers.get("X-Trigger-Token", "") != required_token:
            self._json(401, {"error": "missing or invalid X-Trigger-Token header"})
            return

        length = int(self.headers.get("Content-Length", 0) or 0)
        body_raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(body_raw) if body_raw else {}
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid JSON body"})
            return

        tier1_only = bool(body.get("tier1_only", False))
        tier2_only = bool(body.get("tier2_only", False))
        max_per_sic = body.get("max_per_sic")

        if tier1_only and tier2_only:
            self._json(400, {"error": "tier1_only and tier2_only are mutually exclusive"})
            return

        with _lock:
            if _state["status"] == "running":
                self._json(409, dict(_state))
                return
            _state.update(status="running", started_at=datetime.now(timezone.utc).isoformat(), finished_at=None, row_count=None, error=None)

        thread = threading.Thread(
            target=_run_in_background,
            args=(tier1_only, tier2_only, max_per_sic),
            daemon=True,
        )
        thread.start()

        with _lock:
            self._json(202, dict(_state))


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"hayvin_lead_sourcer server listening on :{port}")
    print(f"  TRIGGER_TOKEN protection: {'ON' if os.environ.get('TRIGGER_TOKEN', '').strip() else 'OFF (POST /run is open)'}")
    server.serve_forever()


if __name__ == "__main__":
    main()
