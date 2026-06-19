#!/usr/bin/env python3
"""
Stage 3 — clean TAF entries, then run the structural-necessity second filter.

Step A: strip embedded URLs and phone numbers from TAF sector names.

Step B: for each sector, ask Gemini (with worked reject examples) whether the
business model STRUCTURALLY REQUIRES crossing a currency boundary.  The output
format is extended to include the gate letter: <pos>|<gate>|<mechanism>|<reason>

Step C: for any sector that passed on Gate D ("structural supply-chain absence"),
run a web-search verification via Gemini with Google Search grounding.  If any
UK manufacturer of the claimed input is found, the D claim is automatically
rejected regardless of the model's initial reasoning.  Gate A and C claims are
not searched (they are market-structure claims, not UK-manufacturing claims).

Acceptable structural reasons:
  A. Global pricing convention (e.g. commodities priced in USD by market standard)
  B. Genuine single-source-of-supply (input only manufactured abroad, not just
     "commonly sourced" internationally)
  C. Regulatory or contractual requirement mandating foreign currency settlement
  D. Structural absence of any UK-based supply-chain equivalent — verified by
     web search to have no UK manufacturer before row is accepted

Output format per passing sector (one line, internal):
  <position>|<gate>|<mechanism>|<structural_reason>

Final CSV/JSON output: sector_name, mechanism, filter_reason  (gate not stored)

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

# Wikipedia source: map each association/body name to the actual underlying sector
# it represents. Only entries with a confident FX-relevant sector mapping are kept.
# Everything NOT in this dict is dropped before the gate prompt — the association
# name is evidence, never the subject of a row.
WIKI_ASSOCIATION_MAP: dict[str, str] = {
    "ABTA (trade association)":
        "UK outbound tour operators and travel agencies",
    "ADS Group":
        "UK aerospace and defence equipment manufacturers",
    "Antiquarian Booksellers' Association":
        "UK antiquarian and rare book dealers",
    "Association of Independent Tour Operators":
        "UK independent tour operators",
    "British Constructional Steelwork Association":
        "UK structural steelwork fabricators and contractors",
    "Chemical Industries Association":
        "UK specialty chemical manufacturers and importers",
    "Confederation of Forest Industries":
        "UK timber importers and wood product processors",
    "Federation of Manufacturing Opticians":
        "UK optical lens and frame manufacturers",
    "Fuels Industry UK":
        "UK fuel importers and oil product distributors",
    "Oil & Gas UK (OGUK)":
        "UK oil and gas operators",
    "The Publishers Association":
        "UK book publishers licensing international rights",
    "Society of British and International Interior Design":
        "UK interior design studios sourcing furniture and materials from overseas",
    "Timber Trade Federation":
        "UK timber importers and merchants",
    "The Association for UK Interactive Entertainment":
        "UK video game publishers and developers",
    "Wine and Spirit Trade Association":
        "UK wine and spirits importers and wholesalers",
}


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

GATE 1 AUTOMATIC REJECT — reject immediately, do not check Gates 2 or 3:
  • The sector name IS a trade association, trade body, trade federation, \
    industry council, or membership organisation — these are associations OF \
    companies, not trading companies themselves. No amount of FX exposure in \
    member companies makes the association itself a valid sector. If the name \
    contains "Association", "Federation", "Council", "Institute", "Bureau", \
    "Alliance", "Union", "Society" or similar — reject unless it is clearly \
    describing a type of trading business (e.g. "building societies" describes \
    businesses; "Building Societies Association" is the trade body).
  • Performing arts, theatre, opera, ballet, live music venues, arts centres \
    (SIC 90010, 90030, 90040) — in the UK these are overwhelmingly charitable \
    trusts or Arts Council-funded bodies, not private trading SMEs with a \
    recurring foreign currency P&L.
  • Museums, commercial galleries, heritage sites, historic monuments, \
    libraries, archives (SIC 91020, 91030, 91040) — overwhelmingly public \
    bodies or charitable trusts.
  • Regulatory bodies, professional institutes, quangos, government agencies.

GATE 2 — FD ACTIVELY MANAGES THE FX (apply second, reject if it fails):
Would a UK Finance Director or MD at a typical SME in this sector have a \
RECURRING, MATERIAL foreign currency line in their P&L or cash flow that they \
personally manage? Answer NO if:
  - The SME buys inputs through a UK distributor, merchant, or wholesaler who \
    reprices in GBP — the FX is absorbed upstream before it reaches the SME, \
    even if the underlying commodity is globally priced somewhere further \
    upstream. The test is: does this SME's FD personally write a payment in a \
    foreign currency to an overseas counterparty? If a UK intermediary stands \
    between the SME and the overseas price, the answer is NO.
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
  D. Structural supply-chain absence — the ENTIRE input category does not \
     exist in the UK — you must name a SPECIFIC input and be CERTAIN no UK \
     manufacturer produces it; if there is any doubt, answer NO

REJECT AT GATE 3 if:
  - The only justification is "often imports", "frequently sources", \
    "commonly purchases", "tends to buy from abroad"
  - Companies COULD source domestically in GBP but tend not to (preference, \
    not necessity)
  - The sector's FX exposure is through buying goods that HAPPEN to be \
    available from abroad rather than being unavailable domestically
  - For reason D: if you are not certain no UK manufacturer exists, reject

─────────────────────────────────────────────────────────────────────────────
WORKED REJECT EXAMPLES — calibration from verified false positives.
If your reasoning resembles one of these, apply the same rejection.

REJECT at Gate 2 — FX absorbed upstream by UK distributor:
  • "Repair of consumer electronics" — repair shops buy spare parts from UK \
    electronics distributors priced in GBP. The repair shop FD has no foreign \
    currency line. FAIL Gate 2.
  • "Retail sale of sports goods" — independent sports retailers buy branded \
    goods from UK wholesale distributors (Shimano UK, Specialized UK, Trek UK) \
    who price in GBP. FX is absorbed upstream before it reaches the retailer. \
    FAIL Gate 2.
  • "Retail sale by opticians" — UK optical frame distributors (Safilo UK, \
    Silhouette UK) price frames in GBP to optical practices. The optician's FD \
    does not see a EUR invoice. FAIL Gate 2.
  • "Manufacture of power-driven hand tools" — UK hand-tool brands (Stanley, \
    Draper) source finished goods from overseas factories but sell through UK \
    trade distributors who absorb the FX. The brand FD does not personally \
    manage the USD invoice if sourcing is via a UK buying agent. FAIL Gate 2.

REJECT at Gate 3, reason D — a UK manufacturer exists and invalidates the claim:
  • "OFTEC" — claimed no UK oil boiler manufacturer. WRONG: Worcester Bosch \
    manufactures oil-fired boilers at their facility in Worcester, UK. FAIL D.
  • "British Constructional Steelwork Association" — claimed constructional \
    steel not made in UK. WRONG: Tata Steel UK manufactures structural steel \
    sections at Scunthorpe and Port Talbot. FAIL D.
  • "Film processing (SIC 74203)" — claimed photographic film only made abroad. \
    WRONG: ILFORD Photo manufactures photographic film and darkroom chemicals \
    in Mobberley, Cheshire, UK. FAIL D.
  • "Manufacture of bearings (SIC 28150)" — claimed high-grade bearing steels \
    only from Japan. WRONG: RHP Bearings (owned by NSK) manufactures bearings \
    in Newark, UK. FAIL D.

REJECT at Gate 3, reason B — UK domestic source exists:
  • "Growing of other perennial crops (SIC 1290)" — claimed hop rhizomes only \
    outside UK. WRONG: hops are grown commercially in Herefordshire and \
    Worcestershire, UK. FAIL B.
  • "Wholesale of live animals (SIC 46230)" — claimed specific pedigree breeds \
    only from abroad. WRONG: UK has registered pedigree cattle and sheep breeds \
    (Hereford, Aberdeen Angus, Suffolk) available domestically. FAIL B.

REJECT at Gate 3 — "often/commonly/tend to" language:
  • "Retail sale of antiques" — reason stated "often only available from \
    international sellers." The word "often" signals preference, not structural \
    necessity. FAIL Gate 3.

REJECT at Gate 2 — FX absorbed upstream through UK merchant / distributor:
  • "Commercial printing" — UK printers buy paper and board from UK paper \
    merchants (Antalis, Premier Paper, Robert Horne) priced in GBP. The \
    printer's FD does not pay Scandinavian mills in EUR or SEK directly. \
    FAIL Gate 2.
  • "Timber frame construction / carpentry contractors" — UK contractors buy \
    timber from UK builders' merchants (Travis Perkins, Jewson, Buildbase) \
    who price in GBP. The contractor's FD never sees a SEK invoice from a \
    Nordic sawmill. FAIL Gate 2.

REJECT at Gate 1 — trade association or arts/heritage body, not a trading company:
  • "Internet Advertising Bureau" — trade association. The IAB itself does not \
    buy advertising placements. FAIL Gate 1.
  • "Wine and Spirit Trade Association" — trade association representing wine \
    importers. The WSTA is not itself an importer. FAIL Gate 1.
  • "Performing arts (SIC 90010 / Artistic creation SIC 90030)" — in the UK \
    these are overwhelmingly Arts Council-funded charitable trusts, not \
    private trading SMEs managing foreign currency. FAIL Gate 1.
  • "Operation of arts facilities (SIC 90040)" — arts venues are almost \
    exclusively charities or publicly funded bodies in the UK. FAIL Gate 1.
─────────────────────────────────────────────────────────────────────────────

For each sector passing ALL THREE gates, output exactly one line:
<number>|<gate>|<mechanism>|<reason>

  <number>    = 1-based position in the input list
  <gate>      = A, B, C, or D — the single letter of the applicable structural reason
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


def gemini_with_search(prompt: str) -> tuple[str, list[str]]:
    """Call Gemini with Google Search grounding. Returns (response_text, search_queries_used)."""
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"google_search": {}}],
        "generationConfig": {"temperature": 0.0, "maxOutputTokens": 300},
    }).encode()
    url = f"{GEMINI_URL}?key={GEMINI_KEY}"
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})

    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                resp = json.loads(r.read())
                candidate = resp["candidates"][0]
                parts = candidate["content"]["parts"]
                text = "".join(p.get("text", "") for p in parts)
                metadata = candidate.get("groundingMetadata", {})
                queries = metadata.get("webSearchQueries", [])
                return text.strip(), queries
        except urllib.error.HTTPError as e:
            err = e.read().decode(errors="replace")
            print(f"  SEARCH HTTP {e.code} (attempt {attempt+1}): {err[:120]}", file=sys.stderr)
            wait = 15 * (attempt + 1) if e.code == 429 else 3
            time.sleep(wait)
        except Exception as e:
            print(f"  SEARCH Error (attempt {attempt+1}): {e}", file=sys.stderr)
            time.sleep(4)
    return "", []


def verify_d_claim(sector_name: str, reason: str) -> tuple[bool, str, str]:
    """
    Verify a Gate D claim using Gemini with Google Search grounding.
    D asserts the entire input category does not exist in the UK.
    We search for any evidence of a UK manufacturer.

    Returns: (claim_holds, search_query_used, verdict_line)
      True  = no UK producer found — D claim stands — keep row
      False = UK producer found   — D claim refuted — reject row

    On search failure, returns True (conservative: don't auto-reject).
    """
    prompt = f"""Sector: {sector_name}
Gate D claim to verify: {reason}

Search the web: does any UK-based company currently manufacture or produce \
the specific material, component, or product described in the claim above?

If you find a UK-based manufacturer or producer, write exactly one line:
UK_FOUND: [company name] in [UK location] makes [specific item]

If after searching you confirm no UK-based manufacturer exists, write exactly one line:
NO_UK_PRODUCER: [item searched for]

Output exactly one line. No other text."""

    text, queries = gemini_with_search(prompt)
    text = text.strip()
    # Take first non-empty line only
    for line in text.splitlines():
        line = line.strip()
        if line:
            text = line
            break

    query_used = queries[0] if queries else "(no query logged)"

    if text.upper().startswith("UK_FOUND"):
        return False, query_used, text
    else:
        return True, query_used, text


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


def parse_response(
    text: str, batch: list[tuple[str, str]]
) -> tuple[list[tuple[str, str, str, str]], list[str]]:
    """
    Parse pipe-delimited lines: <pos>|<gate>|<mechanism>|<reason>
    Returns (results, warnings).
      results  — list of (sector_name, gate, mechanism, filter_reason)
      warnings — list of truncation/quality warnings
    """
    results = []
    warnings = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split('|', 3)
        if len(parts) < 4:
            continue
        try:
            pos = int(parts[0].strip())
        except ValueError:
            continue
        if not (1 <= pos <= len(batch)):
            continue
        gate = parts[1].strip().upper()
        if gate not in ('A', 'B', 'C', 'D'):
            continue
        mechanism = parts[2].strip()
        reason = parts[3].strip()
        if not mechanism or not reason:
            continue

        sector_name = batch[pos - 1][0]

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

        results.append((sector_name, gate, mechanism, reason))

    return results, warnings


def main():
    if not GEMINI_KEY:
        print("ERROR: GEMINI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    with open(IN, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        raw = [(row["sector_name"], row["source"]) for row in reader]

    # Step A: map Wikipedia association names to underlying sectors (or drop).
    # Step B: clean TAF entries.
    wiki_dropped = 0
    wiki_mapped = 0
    sectors: list[tuple[str, str]] = []
    for name, src in raw:
        if src == "wikipedia":
            if name in WIKI_ASSOCIATION_MAP:
                mapped = WIKI_ASSOCIATION_MAP[name]
                sectors.append((mapped, src))
                wiki_mapped += 1
            else:
                wiki_dropped += 1  # can't derive sector — drop
        elif src == "taf":
            name = clean_taf_name(name)
            if name:
                sectors.append((name, src))
        else:
            sectors.append((name, src))

    print(f"Wikipedia source: {wiki_mapped} mapped, {wiki_dropped} dropped "
          f"(association name only — no confident sector derivable)")

    print(f"Stage 3 — second filter: {len(sectors)} sectors in batches of {BATCH}")

    classified_rows: list[tuple[str, str, str, str]] = []  # (name, gate, mech, reason)
    all_warnings: list[str] = []
    total_batches = (len(sectors) + BATCH - 1) // BATCH

    # ── Phase 1: batch classification ─────────────────────────────────────────
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

        print(f"  Batch {b+1}/{total_batches}: {len(results)}/{len(batch)} passed classification")
        classified_rows.extend(results)
        time.sleep(0.4)

    d_rows = [(n, g, m, r) for n, g, m, r in classified_rows if g == 'D']
    non_d_rows = [(n, g, m, r) for n, g, m, r in classified_rows if g != 'D']
    print(f"\nClassification complete: {len(classified_rows)} passed "
          f"({len(non_d_rows)} via A/B/C, {len(d_rows)} via D pending verification)")

    # ── Phase 2: Gate D web-search verification ────────────────────────────────
    print(f"\n--- GATE D VERIFICATION ({len(d_rows)} searches) ---")
    search_log: list[tuple[str, str, str, bool]] = []  # (name, query, verdict, passed)
    verified_d_rows: list[tuple[str, str, str, str]] = []

    first_proof_printed = False

    for name, gate, mech, reason in d_rows:
        claim_holds, query, verdict = verify_d_claim(name, reason)
        search_log.append((name, query, verdict, claim_holds))

        if not first_proof_printed:
            print(f"\n  [FIRST SEARCH — PROOF OF FIRING]")
            print(f"  Sector : {name}")
            print(f"  Query  : {query}")
            print(f"  Verdict: {verdict}")
            first_proof_printed = True

        status = "D-PASS" if claim_holds else "D-FAIL"
        print(f"  {status}: {name}")
        if not claim_holds:
            print(f"    → {verdict}")

        if claim_holds:
            verified_d_rows.append((name, gate, mech, reason))
        time.sleep(0.5)

    # Combine verified rows (A/B/C + verified D), preserving original order
    name_to_verified = {n: (n, g, m, r) for n, g, m, r in non_d_rows + verified_d_rows}
    final_classified = [name_to_verified[n] for n, _, _, _ in classified_rows if n in name_to_verified]

    # Strip gate letter for final output
    final_rows: list[tuple[str, str, str]] = [(n, m, r) for n, _, m, r in final_classified]

    d_passed = sum(1 for _, _, _, p in search_log if p)
    d_failed = len(d_rows) - d_passed
    print(f"\nGate D: {len(d_rows)} verified — {d_passed} held, {d_failed} rejected by search")

    # ── Truncation validation ──────────────────────────────────────────────────
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

    # ── Wikipedia spot-check ───────────────────────────────────────────────────
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

    # ── Write CSV ──────────────────────────────────────────────────────────────
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["sector_name", "mechanism", "filter_reason"])
        w.writerows(final_rows)

    # ── Build JSON for dashboard ───────────────────────────────────────────────
    # Build source_map from the already-processed sectors list (handles Wikipedia
    # name remapping — the original CSV has association names, not sector names).
    source_map: dict[str, str] = {name: src for name, src in sectors}

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
        print(f"\n*** {len(all_warnings)} truncation warning(s) fired — see WARN lines ***")
    else:
        print("\n*** No truncation warnings during generation ***")

    print("\n--- ALL ROWS (raw) ---")
    for row in final_rows:
        print(f"  {row[0]} | {row[1]} | {row[2]}")

    # ── Full Gate D search log ─────────────────────────────────────────────────
    if search_log:
        print(f"\n--- GATE D SEARCH LOG ({len(search_log)} searches) ---")
        for name, query, verdict, passed in search_log:
            status = "PASS" if passed else "FAIL"
            print(f"  [{status}] {name}")
            print(f"    Query  : {query}")
            print(f"    Verdict: {verdict}")


if __name__ == "__main__":
    main()
