"""
FX Discovery — run_pipeline.py
Runs the full pipeline in order then copies JSON to public/data/
"""

import subprocess, sys, shutil, logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s")
log = logging.getLogger(__name__)

ROOT    = Path(__file__).parent.parent
SCRIPTS = ROOT / "scripts"
DATA    = ROOT / "data"
PUBLIC  = ROOT / "public" / "data"

PIPELINE = [
    ("ingest.py",         "Event Radar — pulling live market events"),
    ("discover.py",       "Company Discovery — finding affected businesses"),
    ("linkedin_assist.py","LinkedIn Assist — generating search links"),
    ("outreach.py",       "Outreach Generator — drafting messages"),
]

def run_script(script, description):
    log.info("▶ %s", description)
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / script)],
        capture_output=False,
    )
    if result.returncode != 0:
        log.error("✗ %s failed (exit %d)", script, result.returncode)
        return False
    log.info("✓ %s complete", script)
    return True

def copy_to_public():
    PUBLIC.mkdir(parents=True, exist_ok=True)
    for fname in ["events.json", "leads.json"]:
        src = DATA / fname
        if src.exists():
            shutil.copy(src, PUBLIC / fname)
            log.info("  Copied %s → public/data/", fname)

def main():
    log.info("=" * 50)
    log.info("FX Discovery Pipeline")
    log.info("=" * 50)

    for script, description in PIPELINE:
        if not run_script(script, description):
            log.warning("Pipeline continuing despite error in %s", script)

    copy_to_public()
    log.info("=" * 50)
    log.info("Pipeline complete — dashboard data updated")
    log.info("=" * 50)

if __name__ == "__main__":
    main()
