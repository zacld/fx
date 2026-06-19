#!/usr/bin/env python3
"""
Stage 1 — build sectors_raw.csv from three sources:
  1. ONS SIC 2007 codes — from GitHub (datasets/uk-sic-2007-condensed)
  2. TAF member associations — via Gemini Google Search grounding
  3. Wikipedia UK trade associations category — via Gemini Google Search grounding

Wikipedia and TAF direct URLs are not in this environment's network allowlist,
so both are fetched via the Gemini REST API with Google Search grounding.

Output: sectors_raw.csv  columns: sector_name, source
"""
from __future__ import annotations
import csv, json, os, re, sys, time
import urllib.request, urllib.error

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
OUT = "sectors_raw.csv"


def gemini(prompt: str, use_search: bool = True, temperature: float = 0.1) -> str:
    """Call Gemini REST API; return text or empty string on failure."""
    body: dict = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temperature},
    }
    if use_search:
        body["tools"] = [{"google_search": {}}]

    url = f"{GEMINI_URL}?key={GEMINI_KEY}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                resp = json.loads(r.read())
                parts = resp["candidates"][0]["content"]["parts"]
                return "".join(p.get("text", "") for p in parts)
        except urllib.error.HTTPError as e:
            body_text = e.read().decode(errors="replace")
            print(f"  Gemini HTTP {e.code}: {body_text[:200]}", file=sys.stderr)
            if e.code == 429:
                time.sleep(10 * (attempt + 1))
            else:
                break
        except Exception as e:
            print(f"  Gemini error (attempt {attempt+1}): {e}", file=sys.stderr)
            time.sleep(3)
    return ""


def extract_lines(text: str) -> list[str]:
    """Pull non-empty lines; strip markdown bullets, numbers, asterisks."""
    lines = []
    for line in text.splitlines():
        line = re.sub(r"^\s*[\*\-\•\d]+[\.\)]\s*", "", line).strip()
        line = re.sub(r"\*+", "", line).strip()
        if line and len(line) > 4:
            lines.append(line)
    return lines


# ── Source 1: ONS SIC 2007 from GitHub ──────────────────────────────────────

def fetch_sic() -> list[tuple[str, str]]:
    url = "https://raw.githubusercontent.com/datasets/uk-sic-2007-condensed/main/data/uk-sic-2007-condensed.csv"
    req = urllib.request.Request(url, headers={"User-Agent": "research/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            text = r.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  SIC fetch failed: {e}", file=sys.stderr)
        return []

    rows = []
    reader = csv.DictReader(text.splitlines())
    for row in reader:
        desc = row.get("sic_description", "").strip()
        code = row.get("sic_code", "").strip()
        if desc:
            rows.append((f"{desc} (SIC {code})", "ons_sic"))

    print(f"  SIC: {len(rows)} entries")
    return rows


# ── Source 2: TAF members via Gemini search grounding ───────────────────────

TAF_QUERIES = [
    "List all Trade Association Forum TAF member associations in the UK whose names begin with A, B, or C. Return only the association names, one per line.",
    "List all Trade Association Forum TAF member associations in the UK whose names begin with D, E, or F. Return only the association names, one per line.",
    "List all Trade Association Forum TAF member associations in the UK whose names begin with G, H, or I. Return only the association names, one per line.",
    "List all Trade Association Forum TAF member associations in the UK whose names begin with J, K, L, or M. Return only the association names, one per line.",
    "List all Trade Association Forum TAF member associations in the UK whose names begin with N, O, P, or Q. Return only the association names, one per line.",
    "List all Trade Association Forum TAF member associations in the UK whose names begin with R or S. Return only the association names, one per line.",
    "List all Trade Association Forum TAF member associations in the UK whose names begin with T, U, V, W, X, Y, or Z. Return only the association names, one per line.",
]

def fetch_taf() -> list[tuple[str, str]]:
    seen: set[str] = set()
    sectors: list[tuple[str, str]] = []

    for i, query in enumerate(TAF_QUERIES):
        print(f"  TAF batch {i+1}/{len(TAF_QUERIES)}…")
        text = gemini(query)
        for name in extract_lines(text):
            # Discard lines that look like commentary, not names
            if len(name) > 120:
                continue
            if re.search(r'\b(following|here are|below|based on|search|found|result)\b', name, re.I):
                continue
            key = name.lower().strip()
            if key not in seen:
                seen.add(key)
                sectors.append((name, "taf"))
        time.sleep(1.5)

    print(f"  TAF: {len(sectors)} entries")
    return sectors


# ── Source 3: Wikipedia UK trade associations via Gemini search ──────────────

WIKI_QUERIES = [
    "List all Wikipedia articles in the Category 'Trade associations based in the United Kingdom'. Return only the article titles, one per line. Include as many as you can find.",
    "Continue listing Wikipedia articles in Category:Trade_associations_based_in_the_United_Kingdom that you haven't listed yet, starting from the letter N onward. Return only article titles, one per line.",
]

def fetch_wikipedia() -> list[tuple[str, str]]:
    seen: set[str] = set()
    sectors: list[tuple[str, str]] = []

    for i, query in enumerate(WIKI_QUERIES):
        print(f"  Wikipedia batch {i+1}/{len(WIKI_QUERIES)}…")
        text = gemini(query)
        for name in extract_lines(text):
            if len(name) > 120:
                continue
            if re.search(r'\b(following|here are|below|based on|search|found|category|wikipedia|article)\b', name, re.I):
                continue
            key = name.lower().strip()
            if key not in seen:
                seen.add(key)
                sectors.append((name, "wikipedia"))
        time.sleep(1.5)

    print(f"  Wikipedia: {len(sectors)} entries")
    return sectors


# ── Combine and write ────────────────────────────────────────────────────────

def main():
    if not GEMINI_KEY:
        print("ERROR: GEMINI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    print("Stage 1 — collecting sectors…")

    raw: list[tuple[str, str]] = []
    raw += fetch_sic()
    raw += fetch_taf()
    raw += fetch_wikipedia()

    # Dedup by normalised name
    seen: set[str] = set()
    deduped: list[tuple[str, str]] = []
    for name, source in raw:
        key = re.sub(r'\s+', ' ', name.lower().strip())
        key = re.sub(r'\(sic \d+\)', '', key).strip()
        if key and key not in seen and len(key) > 3:
            seen.add(key)
            deduped.append((name.strip(), source))

    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["sector_name", "source"])
        w.writerows(deduped)

    print(f"\nTotal rows written: {len(deduped)}")
    print(f"Output: {OUT}")
    print("\n--- FIRST 10 ROWS ---")
    for name, src in deduped[:10]:
        print(f"  [{src}] {name}")
    print("--- LAST 10 ROWS ---")
    for name, src in deduped[-10:]:
        print(f"  [{src}] {name}")


if __name__ == "__main__":
    main()
