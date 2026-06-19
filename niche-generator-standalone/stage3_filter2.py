#!/usr/bin/env python3
"""
Stage 3 — clean TAF entries, then run the structural-necessity second filter.

Step A: strip embedded URLs and phone numbers from TAF sector names.

Step B: for each sector, ask Gemini whether the business model STRUCTURALLY
REQUIRES crossing a currency boundary — meaning there is a specific, nameable
reason no domestic-currency alternative exists.

Acceptable structural reasons:
  A. Global pricing convention (e.g. commodities priced in USD by market standard)
  B. Genuine single-source-of-supply (input only manufactured abroad, not just
     "commonly sourced" internationally)
  C. Regulatory or contractual requirement mandating foreign currency settlement
  D. Structural absence of any UK-based supply-chain equivalent

"Often imports / frequently sources / commonly purchases" is NOT a structural
reason — if that is the only justification, the answer is NO.

Output format per passing sector (one line):
  <position>|<mechanism>|<structural_reason>

Input:  niches_generated.csv
Output: niches_final.csv   columns: sector_name, mechanism, filter_reason
        dashboard/data/niches.json
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
You are a UK FX sales analyst. Apply THREE gates in order. A sector must pass \
ALL THREE to output a line. Reject at the first gate that fails — do not \
proceed to later gates.

GATE 1 — SME SCALE (apply first, reject immediately if it fails):
Are there genuinely 20+ active UK PRIVATE TRADING COMPANIES (not charities, \
not public bodies, not universities, not NHS, not government agencies, not \
arts/heritage organisations, not membership associations themselves) operating \
in this sector with real turnover? If the sector is dominated by public \
institutions, large multinationals with centralised treasury, or charities — \
answer NO.

GATE 2 — FD ACTIVELY MANAGES THE FX (apply second, reject if it fails):
Would a UK Finance Director or MD at a typical SME in this sector have a \
RECURRING, MATERIAL foreign currency line in their P&L or cash flow that they \
personally manage? Answer NO if:
  - FX is absorbed upstream (the SME buys in GBP from a UK importer/wholesaler \
    who takes the currency risk)
  - The exposure is incidental or one-off, not structural to recurring \
    operations
  - The sector is professional services (law, accountancy, consulting, tax, \
    education) where FX is irregular and small
  - The company is typically a subsidiary of a large group with centralised \
    treasury functions

GATE 3 — STRUCTURAL NECESSITY (apply only if Gates 1 and 2 pass):
Does this sector STRUCTURALLY REQUIRE crossing a currency boundary — meaning \
there is a SPECIFIC, NAMEABLE reason no domestic-currency alternative exists?

ACCEPTABLE structural reasons (one must clearly apply):
  A. Global pricing convention — the sector's core input or output is priced \
     in a foreign currency by market standard with no GBP equivalent \
     (e.g. crude oil in USD, LME metals in USD, international shipping in USD)
  B. Genuine single-source-of-supply — a specific input is only produced \
     outside the UK with no domestic equivalent whatsoever (e.g. cocoa beans, \
     coffee, tropical hardwoods) — NOT just "commonly imported" but literally \
     unavailable domestically
  C. Regulatory or contractual requirement mandating foreign currency \
     settlement
  D. Structural supply-chain absence — the entire input category does not \
     exist in the UK (e.g. certain rare earths, specific pharmaceutical APIs \
     with no UK producer)

REJECT AT GATE 3 if:
  - The only justification is "often imports", "frequently sources", \
    "commonly purchases", "tends to buy from abroad"
  - Companies COULD source domestically in GBP but tend not to (preference, \
    not necessity)
  - The sector's FX exposure is through buying goods that HAPPEN to be \
    available from abroad rather than being unavailable domestically

For each sector passing ALL THREE gates, output exactly one line:
<number>|<mechanism>|<reason>

  <number>    = 1-based position in the input list
  <mechanism> = 4-7 words describing the specific FX payment flow, ending \
                with a full stop \
                (e.g. "Pays USD to LME commodity exchanges." or \
                "Receives EUR from EU distribution partners.")
  <reason>    = ONE complete sentence stating the specific structural reason \
                (which of A/B/C/D applies and what the specific fact is) — \
                must end with a full stop — must NOT use "often", \
                "frequently", "commonly", "typically", "tend to", or "usually"

Output ONLY passing lines. No headers, no commentary, no partial lines.
If nothing passes: output nothing.

Sectors:
{sectors}
"""


def gemini(prompt: str) -> str:
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.0, "maxOutputTokens": 8192},
    }).encode()
    url = f"{GEMINI_URL}?key={GEMINI_KEY}"
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})

    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
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
    name = re.sub(r'\b0\d[\d\s\(\)\-]{7,}\b', '', name)
    name = re.sub(r'\b\d{5,}\b', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name


def ends_properly(s: str) -> bool:
    """Return True if s ends with sentence-closing punctuation."""
    return bool(s) and s.rstrip()[-1] in '.!?'


def parse_response(text: str, batch: list[tuple[str, str]]) -> tuple[list[tuple[str, str, str]], list[str]]:
    """
    Parse pipe-delimited lines: <pos>|<mechanism>|<reason>
    Returns (results, warnings).
      results  — list of (sector_name, mechanism, filter_reason)
      warnings — list of truncation/quality warnings
    """
    results = []
    warnings = []
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
        if not mechanism or not reason:
            continue

        sector_name = batch[pos - 1][0]

        # Auto-append period to mechanism if it's a complete phrase missing one.
        # If it ends mid-word or in a comma, that's genuine truncation — warn but don't patch.
        if mechanism and not ends_properly(mechanism):
            if mechanism[-1].isalpha() or mechanism[-1] in ')%':
                warnings.append(
                    f"MECHANISM missing period (auto-fixed): '{sector_name}' — '{mechanism}'"
                )
                mechanism = mechanism + '.'
            else:
                warnings.append(
                    f"TRUNCATED mechanism for '{sector_name}': ends mid-phrase — '{mechanism}'"
                )

        if reason and not ends_properly(reason):
            warnings.append(
                f"TRUNCATED reason for '{sector_name}': does not end in punctuation — '{reason}'"
            )

        results.append((sector_name, mechanism, reason))

    return results, warnings


def main():
    if not GEMINI_KEY:
        print("ERROR: GEMINI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

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
    all_warnings: list[str] = []
    total_batches = (len(sectors) + BATCH - 1) // BATCH

    for b in range(total_batches):
        batch = sectors[b * BATCH : (b + 1) * BATCH]
        numbered = "\n".join(f"{i+1}. {name}" for i, (name, _) in enumerate(batch))
        prompt = PROMPT_TEMPLATE.format(sectors=numbered)

        text = gemini(prompt)
        results, warnings = parse_response(text, batch)

        if warnings:
            for w in warnings:
                print(f"  WARN: {w}", file=sys.stderr)
            all_warnings.extend(warnings)

        print(f"  Batch {b+1}/{total_batches}: {len(results)}/{len(batch)} passed")
        final_rows.extend(results)
        time.sleep(0.4)

    # ── Truncation validation ────────────────────────────────────────────────
    print("\n--- TRUNCATION VALIDATION ---")
    truncated = [
        (name, mech, reason)
        for name, mech, reason in final_rows
        if not ends_properly(reason) or not ends_properly(mech)
    ]
    if truncated:
        print(f"  WARNING: {len(truncated)} row(s) with incomplete sentences:")
        for name, mech, reason in truncated:
            if not ends_properly(reason):
                print(f"    REASON truncated  : {name!r} → {reason!r}")
            if not ends_properly(mech):
                print(f"    MECHANISM truncated: {name!r} → {mech!r}")
    else:
        print(f"  OK — all {len(final_rows)} rows end in proper punctuation.")

    # ── Wikipedia spot-check ─────────────────────────────────────────────────
    wiki_rows = [
        (name, mech, reason)
        for name, mech, reason in final_rows
        if any(s == name and src == "wikipedia" for s, src in sectors)
    ]
    if wiki_rows:
        print(f"\n--- WIKIPEDIA SPOT-CHECK ({len(wiki_rows)} rows) ---")
        for name, mech, reason in wiki_rows:
            print(f"  {name!r}")
            print(f"    mechanism : {mech}")
            print(f"    reason    : {reason}")
    else:
        print("\n--- WIKIPEDIA SPOT-CHECK: 0 Wikipedia rows passed ---")

    # ── Write CSV ─────────────────────────────────────────────────────────────
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["sector_name", "mechanism", "filter_reason"])
        w.writerows(final_rows)

    # ── Build source lookup ───────────────────────────────────────────────────
    source_map: dict[str, str] = {}
    try:
        with open(IN, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                source_map[row["sector_name"]] = row.get("source", "")
    except Exception:
        pass

    def fx_direction(mech: str) -> str:
        m = mech.lower()
        has_pays     = "pays" in m
        has_receives = "receives" in m or "trades" in m
        if has_pays and has_receives:
            return "both"
        if has_receives:
            return "receives"
        return "pays"

    sectors_raw_count = 0
    try:
        with open("sectors_raw.csv", newline="", encoding="utf-8") as f:
            sectors_raw_count = sum(1 for _ in csv.reader(f)) - 1
    except Exception:
        pass

    import datetime
    payload = {
        "meta": {
            "generated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sectors_raw": sectors_raw_count,
            "first_filter": len(sectors),
            "final": len(final_rows),
        },
        "niches": [
            {
                "sector_name": name,
                "mechanism": mech,
                "filter_reason": reason,
                "source": source_map.get(name, ""),
                "fx_direction": fx_direction(mech),
            }
            for name, mech, reason in final_rows
        ],
    }

    import pathlib
    data_dir = pathlib.Path("dashboard") / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    json_path = data_dir / "niches.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    print(f"\nTotal passing second filter: {len(final_rows)} / {len(sectors)}")
    print(f"Output: {OUT}")
    print(f"Dashboard data: {json_path}")

    if all_warnings:
        print(f"\n*** {len(all_warnings)} truncation warning(s) fired during generation — see WARN lines ***")
    else:
        print("\n*** No truncation warnings during generation ***")

    print("\n--- ALL ROWS (raw) ---")
    for row in final_rows:
        print(f"  {row[0]} | {row[1]} | {row[2]}")


if __name__ == "__main__":
    main()
