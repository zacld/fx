#!/usr/bin/env python3
"""
Stage 2 — first filter: yes/no FX mechanism question via Gemini.

For each sector, ask: does a UK business in this sector systematically pay
or receive foreign currency as a direct, unavoidable result of its core
business model?

Batches 30 sectors per call. Gemini returns only the 1-based positions of
YES sectors (maximally compact, avoids truncation).

Output: niches_generated.csv  columns: sector_name, source
        (only rows that passed YES)
"""
from __future__ import annotations
import csv, json, os, re, sys, time
import urllib.request, urllib.error

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
IN  = "sectors_raw.csv"
OUT = "niches_generated.csv"
BATCH = 25


PROMPT_TEMPLATE = """\
You are a currency risk analyst assessing UK business sectors for foreign currency exposure.

For each numbered sector below, answer YES if UK companies in that sector \
systematically pay or receive money in a FOREIGN CURRENCY as a DIRECT, \
UNAVOIDABLE result of their core business model.

Answer YES if the sector involves:
- Buying goods or raw materials from overseas (direct importer)
- Paying overseas staff or contractors (offshore labour)
- Selling goods/services abroad and receiving foreign currency
- Trading commodities benchmarked in USD (metals, oil, grain, etc.)
- Paying for US-domiciled platform licences (cloud, SaaS, media rights)
- Providing international transport or freight services
- Underwriting cross-border insurance or risk

Answer NO if:
- FX exposure is absorbed upstream by a UK distributor or wholesaler
- The sector is primarily domestic and pays/receives in GBP only
- Any international trade is incidental, not structural to the business model

Return ONLY a JSON array of the 1-based position numbers of sectors that \
answer YES. Nothing else. Example: [1, 3, 7, 12]
If none qualify: []

Sectors:
{sectors}
"""


def gemini(prompt: str) -> str:
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.0, "maxOutputTokens": 2048},
    }).encode()
    url = f"{GEMINI_URL}?key={GEMINI_KEY}"
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})

    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                resp = json.loads(r.read())
                parts = resp["candidates"][0]["content"]["parts"]
                return "".join(p.get("text", "") for p in parts)
        except urllib.error.HTTPError as e:
            err = e.read().decode(errors="replace")
            print(f"  HTTP {e.code} (attempt {attempt+1}): {err[:120]}", file=sys.stderr)
            wait = 15 * (attempt + 1) if e.code == 429 else 3
            time.sleep(wait)
        except Exception as e:
            print(f"  Error (attempt {attempt+1}): {e}", file=sys.stderr)
            time.sleep(4)
    return ""


def parse_positions(text: str, batch_size: int) -> list[int]:
    """
    Extract 1-based YES positions from Gemini response.
    Handles: markdown fences, truncated arrays (no closing ]), pure number lists.
    """
    text = re.sub(r'```[^\n]*\n?', '', text).strip()

    # Extract all integers from anywhere in the response
    nums = re.findall(r'\b(\d+)\b', text)
    positions = []
    seen = set()
    for n in nums:
        p = int(n)
        if 1 <= p <= batch_size and p not in seen:
            seen.add(p)
            positions.append(p)
    return positions


def process_batch(batch: list[tuple[str, str]]) -> list[tuple[str, str]]:
    numbered = "\n".join(f"{i+1}. {name}" for i, (name, _) in enumerate(batch))
    prompt = PROMPT_TEMPLATE.format(sectors=numbered)

    text = gemini(prompt)

    if not text.strip():
        print("  WARN: empty response from Gemini", file=sys.stderr)
        return []

    positions = parse_positions(text, len(batch))
    return [(batch[p - 1][0], batch[p - 1][1]) for p in positions]


def main():
    if not GEMINI_KEY:
        print("ERROR: GEMINI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    with open(IN, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        sectors = [(row["sector_name"], row["source"]) for row in reader]

    total_batches = (len(sectors) + BATCH - 1) // BATCH
    print(f"Stage 2 — first filter: {len(sectors)} sectors in {total_batches} batches of {BATCH}")

    yes_rows: list[tuple[str, str]] = []

    for b in range(total_batches):
        batch = sectors[b * BATCH : (b + 1) * BATCH]
        yes = process_batch(batch)
        print(f"  Batch {b+1}/{total_batches}: {len(yes)}/{len(batch)} YES")
        yes_rows.extend(yes)
        time.sleep(0.4)

    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["sector_name", "source"])
        w.writerows(yes_rows)

    print(f"\nTotal YES: {len(yes_rows)} / {len(sectors)}")
    print(f"Output: {OUT}")
    print("\n--- FIRST 10 ROWS ---")
    for name, src in yes_rows[:10]:
        print(f"  [{src}] {name}")
    print("--- LAST 10 ROWS ---")
    for name, src in yes_rows[-10:]:
        print(f"  [{src}] {name}")


if __name__ == "__main__":
    main()
