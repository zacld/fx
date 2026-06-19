#!/usr/bin/env python3
"""
Stage 3 — clean TAF entries, then run the two-question second filter.

Step A: strip embedded URLs and phone numbers from TAF sector names.

Step B: for each sector surviving the first filter, ask Gemini:
  Q1 — Is there a meaningful number of UK companies operating in this sector
       at material scale (20+ active businesses with real revenue)?
  Q2 — Is the FX exposure something a UK Finance Director at an SME would
       actively manage themselves — not something absorbed upstream by a
       supplier, or downstream by a customer, or by a specialist treasury
       function the SME doesn't have?

Only sectors passing BOTH questions make the final file.
For passing sectors, Gemini also returns: mechanism (4-6 words describing the
FX flow) and filter_reason (one sentence explaining why it passed).

Output format is compact to avoid truncation: one line per passing sector:
  <position>|<mechanism>|<filter_reason>

Input:  niches_generated.csv
Output: niches_final.csv   columns: sector_name, mechanism, filter_reason
"""
from __future__ import annotations
import csv, json, os, re, sys, time
import urllib.request, urllib.error

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL  = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
IN   = "niches_generated.csv"
OUT  = "niches_final.csv"
BATCH = 20


PROMPT_TEMPLATE = """\
You are a UK FX sales analyst. Your job is to identify sectors where UK TRADING \
SMEs (private companies with an FD or MD making active financial decisions) have \
STRUCTURAL, RECURRING foreign currency payment flows large enough to justify a \
conversation about FX risk management.

For each numbered sector below, apply TWO filters strictly:

Q1 — REAL SME SCALE: Are there genuinely 20+ active UK PRIVATE TRADING COMPANIES \
(not charities, not public bodies, not government agencies, not arts/heritage \
organisations, not professional associations themselves) operating in this sector \
with real turnover? Answer NO if the sector is dominated by public bodies, \
museums, universities, charities, or membership organisations.

Q2 — FD ACTIVELY MANAGES THE FX: Would a UK Finance Director or MD at a \
typical SME in this sector have a RECURRING, MATERIAL foreign currency line in \
their P&L or cash flow that they personally manage? Answer NO if:
  - FX is absorbed upstream (they buy in GBP from a UK intermediary)
  - The exposure is incidental or one-off, not structural
  - The sector's FX is driven mainly by occasional international visitors \
    or tourism (e.g. ticket sales to foreign tourists — the venue doesn't \
    manage this as a currency position)
  - The sector is professional services (law, accountancy, consulting, tax) \
    where international clients exist but the FX exposure is typically small, \
    irregular, and not managed as a currency risk
  - The company is typically a subsidiary of a large group with centralised treasury

For each sector passing BOTH filters, output exactly one line:
<number>|<mechanism>|<reason>

  <number>    = 1-based position in the input list
  <mechanism> = 4-7 words describing the specific FX payment flow \
                (e.g. "pays EUR to European suppliers" or "receives USD from US buyers")
  <reason>    = one complete sentence, max 20 words, explaining why this specific \
                sector has structural, SME-managed FX exposure

Output ONLY passing lines. No headers, no commentary, no partial lines.
If nothing passes: output nothing.

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


def clean_taf_name(name: str) -> str:
    """Strip URLs, phone numbers, and stray digits from TAF sector names."""
    name = re.sub(r'https?://\S+', '', name)
    name = re.sub(r'www\.\S+', '', name)
    name = re.sub(r'\b0\d[\d\s\(\)\-]{7,}\b', '', name)   # UK phone numbers
    name = re.sub(r'\b\d{5,}\b', '', name)                 # long digit strings
    name = re.sub(r'\s+', ' ', name).strip()
    return name


def parse_response(text: str, batch: list[tuple[str, str]]) -> list[tuple[str, str, str]]:
    """
    Parse pipe-delimited lines: <pos>|<mechanism>|<reason>
    Returns list of (sector_name, mechanism, filter_reason).
    """
    results = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split('|', 2)
        if len(parts) < 3:
            continue
        try:
            pos = int(parts[0].strip())
        except ValueError:
            continue
        if not (1 <= pos <= len(batch)):
            continue
        mechanism = parts[1].strip()
        reason = parts[2].strip()
        if mechanism and reason:
            sector_name = batch[pos - 1][0]
            results.append((sector_name, mechanism, reason))
    return results


def main():
    if not GEMINI_KEY:
        print("ERROR: GEMINI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    # Load first-filter survivors
    with open(IN, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        raw = [(row["sector_name"], row["source"]) for row in reader]

    # Step A: clean TAF entries
    sectors: list[tuple[str, str]] = []
    for name, src in raw:
        if src == "taf":
            name = clean_taf_name(name)
        if name:
            sectors.append((name, src))

    print(f"Stage 3 — second filter: {len(sectors)} sectors in batches of {BATCH}")

    final_rows: list[tuple[str, str, str]] = []
    total_batches = (len(sectors) + BATCH - 1) // BATCH

    for b in range(total_batches):
        batch = sectors[b * BATCH : (b + 1) * BATCH]
        numbered = "\n".join(f"{i+1}. {name}" for i, (name, _) in enumerate(batch))
        prompt = PROMPT_TEMPLATE.format(sectors=numbered)

        text = gemini(prompt)
        results = parse_response(text, batch)

        print(f"  Batch {b+1}/{total_batches}: {len(results)}/{len(batch)} passed")
        final_rows.extend(results)
        time.sleep(0.4)

    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["sector_name", "mechanism", "filter_reason"])
        w.writerows(final_rows)

    print(f"\nTotal passing second filter: {len(final_rows)} / {len(sectors)}")
    print(f"Output: {OUT}")

    print("\n--- FIRST 10 ROWS (raw) ---")
    for row in final_rows[:10]:
        print(f"  {row[0]} | {row[1]} | {row[2]}")
    print("--- LAST 10 ROWS (raw) ---")
    for row in final_rows[-10:]:
        print(f"  {row[0]} | {row[1]} | {row[2]}")


if __name__ == "__main__":
    main()
