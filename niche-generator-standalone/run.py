#!/usr/bin/env python3
"""
Niche Generator — full pipeline runner.

Runs all three stages in sequence:
  stage1_scrape.py   → sectors_raw.csv      (source list: SIC + TAF + Wikipedia)
  stage2_filter1.py  → niches_generated.csv (first filter: yes/no FX mechanism)
  stage3_filter2.py  → niches_final.csv     (second filter: scale + FD-managed)

Requires: GEMINI_API_KEY environment variable set.

Usage:
  export GEMINI_API_KEY=...
  python3 run.py
"""
import os, subprocess, sys

def run_stage(script: str) -> None:
    print(f"\n{'='*60}")
    print(f"Running {script}…")
    print('='*60)
    result = subprocess.run([sys.executable, script], check=False)
    if result.returncode != 0:
        print(f"\nERROR: {script} exited with code {result.returncode}", file=sys.stderr)
        sys.exit(result.returncode)

def main():
    if not os.environ.get("GEMINI_API_KEY"):
        print("ERROR: GEMINI_API_KEY is not set.", file=sys.stderr)
        sys.exit(1)

    run_stage("stage1_scrape.py")
    run_stage("stage2_filter1.py")
    run_stage("stage3_filter2.py")

    print("\n" + "="*60)
    print("Pipeline complete.")
    print("  sectors_raw.csv      — source sector list")
    print("  niches_generated.csv — passed first filter (FX mechanism yes/no)")
    print("  niches_final.csv     — passed second filter (scale + FD-managed)")
    print("="*60)

if __name__ == "__main__":
    main()
