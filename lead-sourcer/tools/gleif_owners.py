"""
tools/gleif_owners.py — who owns each tracked company, from the Global LEI register's free daily files (sourcer/gleif.py).

  python3 tools/gleif_owners.py --tracked tracked.json --out gleif.json [--cache DIR]

Prints counts and the columns it found (company names only — no people; the repo is public).
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sourcer import gleif  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracked", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache", default=os.path.expanduser("~/.cache/fx-lead-sourcer/gleif"))
    a = ap.parse_args()
    tracked = set(json.load(open(a.tracked)))
    try:
        paths = gleif.download(a.cache)
        out = gleif.owners(paths, tracked)
    except Exception as e:  # noqa: BLE001 — GLEIF's site refusing a download (403, 17 Nov 2026) skips this one source
        print(f"GLEIF: the LEI files couldn't be read today ({e}) — this source is skipped")
        gleif.save({}, a.out)
        return
    gleif.save(out, a.out)
    with_parent = sum(1 for v in out.values() if v["ultimate"] or v["direct"])
    foreign = sum(1 for v in out.values() if v["uk"] is False)
    people = sum(1 for v in out.values() if "individuals" in v["exception"])
    print(f"GLEIF: {len(out):,} of {len(tracked):,} tracked companies hold an LEI; {with_parent:,} name a parent "
          f"({foreign:,} abroad, {with_parent - foreign:,} in the UK); {people:,} owned by individuals")


if __name__ == "__main__":
    main()
