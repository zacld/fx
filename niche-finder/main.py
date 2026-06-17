#!/usr/bin/env python3
"""
Niche Finder Engine CLI

Usage:
  python3 main.py                                  # structural niches only (no API key needed)
  python3 main.py --check-competition              # + competition check for all niches
  python3 main.py --contingent candidates.csv      # + score contingent candidates
  python3 main.py --recheck-competition            # reload existing JSON, recheck stale niches
  python3 main.py --recheck-competition --older-than-days 14
  python3 main.py --out my_run                     # custom output prefix

Provider auto-detection (first available wins):
  1. ANTHROPIC_API_KEY            → claude-sonnet-4-6 with built-in web search
  2. GEMINI_API_KEY + SERPER_API_KEY → Gemini analysis + Serper web search

Keys are loaded from the project .env file automatically if present.

Output files:
  {prefix}_niches.json   — dashboard source
  {prefix}_niches.csv    — spreadsheet-friendly view
  dashboard/data/niches.json  — auto-updated (omit with --no-dashboard-copy)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("niche_finder")

HERE = Path(__file__).parent


# ── .env loader ──────────────────────────────────────────────────────────────

def _load_dotenv(paths: list) -> None:
    """
    Load key=value pairs from the first .env file found.
    Only sets variables that aren't already in the environment.
    """
    for env_path in paths:
        p = Path(env_path)
        if not p.exists():
            continue
        loaded = 0
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
                    loaded += 1
        if loaded:
            logger.debug("Loaded %d vars from %s", loaded, p)
        return


# ── API client factory ───────────────────────────────────────────────────────

def _require_competition_client():
    """
    Build a competition client from available API keys.
    Exits with a helpful message if no viable keys are found.
    """
    from niche_finder.competition import make_competition_client

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    gemini_key = os.environ.get("GEMINI_API_KEY")
    serper_key = os.environ.get("SERPER_API_KEY")
    gemini_model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

    if not anthropic_key and not gemini_key:
        logger.error(
            "No usable API keys found for competition checks.\n"
            "Need either ANTHROPIC_API_KEY or GEMINI_API_KEY.\n"
            "Add them to your .env file or export them before running."
        )
        sys.exit(1)

    try:
        client = make_competition_client(
            anthropic_api_key=anthropic_key,
            gemini_api_key=gemini_key,
            gemini_model_name=gemini_model,
        )
        provider = client["provider"]
        if provider == "anthropic":
            logger.info("Using provider: Anthropic (claude-sonnet-4-6 + web_search)")
        elif provider == "gemini":
            logger.info("Using provider: Gemini (%s) with built-in Google Search", gemini_model)
        return client
    except (ImportError, ValueError) as exc:
        logger.error("Could not build competition client: %s", exc)
        sys.exit(1)


def _require_anthropic_client():
    """For contingent scoring, which specifically needs Anthropic + web_search."""
    try:
        import anthropic
    except ImportError:
        logger.error("anthropic package not installed. Run: pip install -r requirements.txt")
        sys.exit(1)
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        logger.error(
            "Contingent scoring requires ANTHROPIC_API_KEY (uses claude-sonnet-4-6 "
            "with web_search to validate foreign-currency evidence).\n"
            "Set ANTHROPIC_API_KEY in your .env file."
        )
        sys.exit(1)
    return anthropic.Anthropic(api_key=api_key)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _load_payer_profiles() -> dict:
    path = HERE / "data" / "payer_profiles.json"
    if not path.exists():
        logger.warning("payer_profiles.json not found — using empty profiles")
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _copy_to_dashboard(json_path: Path) -> None:
    data_dir = HERE / "dashboard" / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    dest = data_dir / "niches.json"
    shutil.copy2(json_path, dest)

    profiles_src = HERE / "data" / "payer_profiles.json"
    if profiles_src.exists():
        shutil.copy2(profiles_src, data_dir / "payer_profiles.json")

    logger.info("Dashboard data updated → %s", dest)


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> None:
    # Auto-load .env (project root or parent)
    _load_dotenv([HERE / ".env", HERE.parent / ".env"])

    parser = argparse.ArgumentParser(
        description="Find and rank UK business niches with hidden FX exposure.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--contingent", metavar="FILE",
        help="CSV of contingent candidates to score (requires ANTHROPIC_API_KEY)",
    )
    parser.add_argument(
        "--check-competition", action="store_true", dest="check_competition",
        help="Run web-search competition check for all niches",
    )
    parser.add_argument(
        "--recheck-competition", action="store_true", dest="recheck_competition",
        help="Reload existing output JSON and recheck stale niches",
    )
    parser.add_argument(
        "--older-than-days", type=int, default=30, metavar="N", dest="older_than_days",
        help="Staleness threshold for --recheck-competition (default: 30)",
    )
    parser.add_argument(
        "--out", default="niche_finder", metavar="PREFIX",
        help="Output file prefix (default: niche_finder)",
    )
    parser.add_argument(
        "--workers", type=int, default=6, metavar="N",
        help="Concurrent API workers (default: 6)",
    )
    parser.add_argument(
        "--no-dashboard-copy", action="store_true", dest="no_dashboard_copy",
        help="Skip copying output to dashboard/data/",
    )

    args = parser.parse_args()

    out_json = Path(f"{args.out}_niches.json")
    out_csv  = Path(f"{args.out}_niches.csv")

    from niche_finder.structural import generate_structural_niches
    from niche_finder.ranking import rank_niches
    from niche_finder.output import write_csv, write_json, load_json

    # ── Recheck mode ────────────────────────────────────────────────────────
    if args.recheck_competition:
        if not out_json.exists():
            logger.error("No existing output at %s — run a generation pass first.", out_json)
            sys.exit(1)

        competition_client = _require_competition_client()
        from niche_finder.competition import check_competition_batch

        niches = load_json(str(out_json))
        logger.info("Rechecking niches older than %d days…", args.older_than_days)
        niches = check_competition_batch(
            niches, competition_client,
            max_workers=args.workers, older_than_days=args.older_than_days,
        )
        niches = rank_niches(niches)
        write_json(niches, str(out_json))
        write_csv(niches, str(out_csv))
        logger.info("Saved: %s  %s", out_json, out_csv)
        if not args.no_dashboard_copy:
            _copy_to_dashboard(out_json)
        return

    # ── Generation pass ──────────────────────────────────────────────────────
    logger.info("Generating structural niches…")
    niches = generate_structural_niches()
    logger.info("  %d structural niches generated", len(niches))

    if args.contingent:
        competition_client_for_overlap = _require_competition_client()
        # Use Anthropic for web_search_20250305 if available; fall back to
        # Gemini Google Search grounding (same real-search capability).
        anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
        if anthropic_key:
            try:
                import anthropic as _ant
                anthropic_client = _ant.Anthropic(api_key=anthropic_key)
                logger.info("Contingent scoring: Anthropic (claude-sonnet-4-6 + web_search)")
            except ImportError:
                anthropic_client = None
        else:
            anthropic_client = None
        if anthropic_client is None:
            logger.info(
                "Contingent scoring: Gemini (%s) + Google Search grounding "
                "(ANTHROPIC_API_KEY not set)",
                os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
            )

        from niche_finder.contingent import load_candidates_csv, score_contingent_batch
        rows = load_candidates_csv(args.contingent)
        logger.info("Scoring %d contingent candidates (with overlap detection)…", len(rows))
        payer_profiles = _load_payer_profiles()
        contingent = score_contingent_batch(
            rows,
            payer_profiles,
            anthropic_client,                      # None if using Gemini
            max_workers=args.workers,
            existing_niches=list(niches),
            competition_client=competition_client_for_overlap,
        )
        niches.extend(contingent)
        logger.info("  %d contingent niches accepted (after overlap detection)", len(contingent))

    if args.check_competition or args.contingent:
        competition_client = _require_competition_client()
        from niche_finder.competition import check_competition_batch
        logger.info("Checking competition for %d niches…", len(niches))
        niches = check_competition_batch(
            niches, competition_client, max_workers=args.workers,
        )

    niches = rank_niches(niches)
    write_json(niches, str(out_json))
    write_csv(niches, str(out_csv))

    unchecked = sum(1 for n in niches if not n.competition)
    logger.info(
        "Done. %d niches → %s / %s  (%d without competition data)",
        len(niches), out_json, out_csv, unchecked,
    )
    if unchecked and not (args.check_competition or args.contingent):
        logger.info(
            "Tip: run with --check-competition to populate competition scores"
        )

    if not args.no_dashboard_copy:
        _copy_to_dashboard(out_json)


if __name__ == "__main__":
    main()
