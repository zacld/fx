"""
sourcer/turnover_text.py — turnover and cost of sales read from the profit
and loss account in accounts text (pdftotext -layout, OCR of scanned pages,
or the text of a tagged filing whose turnover isn't tagged), saying exactly
what the figure is:

  - group or company: a consolidated profit and loss account (or a "Group"
    column) is the group's figure; otherwise the company's;
  - this year or last: from the column years ("2024  2023", or the rare
    "2023  2024"), else this year first;
  - £, £'000 or £m: from the nearest table heading above the line; a table in
    dollars or euros is reported as not in pounds, never converted;
  - where: the page, so the Accounts page can link straight to it.

When a profit and loss account is there but shows no turnover (a medium-sized
company's abridged accounts start at gross profit), or there's none at all
(filleted small-company accounts), it says so rather than guessing.

Real filings behind every rule are in tests/test_turnover_cases.py.
"""

from __future__ import annotations

import re
from typing import Optional

from sourcer import fx_text

# The primary statement's heading. "Consolidated" / "Group" in it means group figures.
PL_HEADING = re.compile(
    r"(?:(consolidated|group)\s+(?:and\s+company\s+)?)?(?:statement\s+of\s+(?:comprehensive\s+)?income|"
    r"(?:statement\s+of\s+)?profit\s+(?:and|or)\s+loss(?:\s+account)?(?:\s+and\s+other\s+comprehensive\s+income)?|"
    r"income\s+statement)", re.I)
# A turnover row: the label at the start of the line, then the figures.
_TURNOVER_LABEL = r"(?:group\s+|total\s+)?(?:turnover|revenue)(?:\s+from\s+continuing\s+operations)?"
_COST_LABEL = r"cost\s+of\s+(?:sales|revenue|goods\s+sold)"
_GROSS_LABEL = r"gross\s+(?:profit|loss|\(loss\)\s*/\s*profit|profit\s*/\s*\(loss\))"
# Figures in a row: "45,123", "(30,000)", "45.1" (£m), "45.123" (OCR's comma). Note numbers ("3", "4.2") are dropped
# by position: they come before the first real figure and are short.
_CELL = re.compile(r"\(\s?-?(?:\d{1,3}(?:[,.]\d{3})+|\d+)(?:\.\d+)?\s?\)|-?(?:\d{1,3}(?:[,.]\d{3})+|\d+)(?:\.\d+)?|(?<!\S)[-–—](?!\S)")   # a lone dash cell is nil; OCR debris ("—~—«") isn't
_YEAR = re.compile(r"(?<![\d,.£$€])((?:19|20)\d\d)(?![\d,])")
_WORDS = re.compile(r"[A-Za-z]{3,}")
MIN_TURNOVER = 100_000   # under this a "turnover" is a misread (a note number, a ratio, a £m figure without its heading)


_KPI = re.compile(r"\b(?:million|bn|billion)\b|£\s?\d[\d.,]*\s?m\b|%", re.I)


def _row(page: str, label: str) -> Optional[re.Match]:
    """
    The first table row starting with `label` — not a sentence (at most 3 words after the label) and not a KPI
    line ("Turnover: £42.2 million (2025: £36.5million)", "Turnover 11,984 16,540 (28)%").
    """
    for m in re.finditer(rf"^[ \t]*({label})\b[ \t:.]*(.*)$", page, re.I | re.M):
        if len(_WORDS.findall(m.group(2))) <= 3 and _CELL.search(m.group(2)) and not _KPI.search(m.group(2)):
            return m
    return None


def _figures(rest: str, millions: bool) -> list[tuple[float, bool]]:
    """[(size, bracketed)] for the figures in a row, the note number dropped."""
    tokens = [t for t in _CELL.findall(rest) if not _YEAR.fullmatch(t.strip("() "))]
    out = []
    for t in tokens:
        value = fx_text._value(t, millions=millions)
        if value is not None:
            out.append((value, fx_text._negative(t)))
    # A leading note number: "Turnover  3  45,123  41,000" / "Revenue 4.1 182.4 170.1" — short, no thousands separator,
    # and followed by at least two figures (this year and last).
    if len(out) >= 3 and re.fullmatch(r"\d{1,2}(?:\.\d)?", tokens[0].strip()):
        out = out[1:]
    # ... or before a first year's only figure: "TURNOVER 3 384,712,050" (Greanco: no comparative column)
    elif len(out) == 2 and re.fullmatch(r"\d{1,2}(?:\.\d)?", tokens[0].strip()) and out[1][0] >= 1_000 * max(out[0][0], 1):
        out = out[1:]
    return out


def _columns(page: str, before: int) -> tuple[list[int], bool]:
    """
    (the column years, whether there's a Group column) from the nearest heading
    line above position `before` that has two or more years.
    """
    lines = page[:before].split("\n")[-25:]
    for i in range(len(lines) - 1, -1, -1):
        years = [int(y) for y in _YEAR.findall(lines[i])]
        if len(years) >= 2 and len(_WORDS.findall(_YEAR.sub("", lines[i]))) <= 6:
            # "Group  Group  Company  Company" on the years line or just above it
            return years, any(re.search(r"\bgroup\b", line, re.I) for line in lines[max(0, i - 3): i + 1])
    near = "\n".join(lines[-25:])
    return [], bool(re.search(r"^\s*group\s+(?:group\s+)?company", near, re.I | re.M))


def _pick(figures: list[tuple[float, bool]], years: list[int]) -> tuple[Optional[float], Optional[float]]:
    """(this year, last year) from a row's figures and its column years (first column of each year: the group's)."""
    if not figures:
        return None, None
    if len(years) >= 2 and len(figures) >= len(years):
        latest = max(years)
        earlier = [y for y in years if y < latest]
        current = figures[years.index(latest)][0]
        prior = figures[years.index(max(earlier))][0] if earlier else None
        return current, prior
    return figures[0][0], figures[1][0] if len(figures) > 1 else None


def _says_dollars(text: str) -> bool:
    return re.search(r"US\$|USD|dollar", text, re.I) is not None


_HEADING_LINE = re.compile(
    r"^[ \t]*(?:the\s+)?(?:(?:consolidated|group)\s+(?:and\s+company\s+)?|company\s+)?"
    r"(?:statement\s+of\s+(?:comprehensive\s+)?income|(?:statement\s+of\s+)?profit\s+(?:and|or)\s+loss|income\s+statement)"
    r"[^\n]{0,80}$", re.I | re.M)


def statement_pages(text: str) -> tuple[list[str], list[bool]]:
    """
    One long text (a tagged filing) cut into sections at the primary statements' heading lines ("Consolidated
    profit and loss account", "Statement of comprehensive income"), so the statement's turnover row is read, not a
    KPI table's or a note's: (sections, whether each starts at a statement heading).
    """
    cuts = [m.start() for m in _HEADING_LINE.finditer(text) if len(m.group(0).split()) <= 12]
    bounds = [0, *cuts, len(text)]
    sections = [text[a:b] for a, b in zip(bounds, bounds[1:]) if text[a:b].strip()]
    starts = [i > 0 or (cuts[:1] == [0]) for i in range(len(sections))] if cuts else [False] * len(sections)
    if cuts and cuts[0] != 0 and not text[:cuts[0]].strip():
        starts[0] = True
    return sections, starts


def read_page(page: str, number: int = 0, ocr: bool = False, statement: Optional[bool] = None) -> Optional[dict]:
    """
    The profit and loss figures on one page of accounts text, or None when the
    page has no turnover or gross-profit row:
      {"turnover", "turnover_prior", "cost_of_sales", "cost_of_sales_prior",
       "basis": "group" | "company", "unit": "£" | "£'000" | "£m",
       "page", "line", "check"}
    turnover is None with a "check" when the page starts at gross profit
    (turnover not disclosed) or its table isn't in pounds.
    """
    turnover = _row(page, _TURNOVER_LABEL)
    gross = _row(page, _GROSS_LABEL)
    if not turnover and not gross:
        return None
    anchor = turnover or gross
    multiplier, currency = fx_text._scale(page[: anchor.start()])
    if ocr and currency == "$" and ("£" in page or not _says_dollars(page)):
        currency = "£"   # OCR often reads "£" as "$": only a page that says dollars and never £ is in dollars
    unit = {1.0: "£", 1_000.0: "£'000", 1_000_000.0: "£m"}[multiplier]
    heading = PL_HEADING.search(page[: anchor.start()]) or PL_HEADING.search(page)
    if statement is not None:   # a tagged filing's section: only one starting at a statement heading is one
        heading = heading if statement else None
    years, group_column = _columns(page, anchor.start())
    basis = "group" if (heading and heading.group(1)) or group_column else "company"
    out = {"turnover": None, "turnover_prior": None, "cost_of_sales": None, "cost_of_sales_prior": None,
           "basis": basis, "unit": unit, "page": number, "line": "", "check": "", "statement": bool(heading),
           "years": years, "unit_stated": bool(fx_text._HEADING.search(page[: anchor.start()]))}
    if currency != "£":
        out["check"] = f"profit and loss in {currency} ({' '.join(anchor.group(0).split())[:80]}), not in pounds"
        return out
    millions = multiplier == 1_000_000.0

    def pair(row: Optional[re.Match]) -> tuple[Optional[float], Optional[float]]:
        if not row:
            return None, None
        a, b = _pick(_figures(row.group(2), millions), years)
        return (a * multiplier if a is not None else None), (b * multiplier if b is not None else None)

    t, tp = pair(turnover)
    cost = _row(page, _COST_LABEL)
    c, cp = pair(cost)
    g, gp = pair(gross)
    out.update(cost_of_sales=c, cost_of_sales_prior=cp,
               line=" ".join((turnover or gross).group(0).split())[:120])
    # Turnover = cost of sales + gross profit on the face of the statement: a turnover cell that disagrees (by more
    # than 2%) is an OCR misread ("$3,109,419" for £53,109,419), and a missing one can be worked out — said so.
    derived = c + g if c is not None and g is not None and heading else None
    if derived and (t is None or abs(t - derived) > 0.02 * derived):
        how = "unreadable" if t is not None else "not read"
        dp = cp + gp if cp is not None and gp is not None else None
        out.update(turnover=derived, turnover_prior=dp, derived=True,
                   line=f"cost of sales + gross profit (the turnover line is {how})")
        return out if derived >= MIN_TURNOVER else None
    if t is None:
        out.update(cost_of_sales=None, cost_of_sales_prior=None,
                   check="turnover not disclosed: the profit and loss account starts at gross profit "
                         "(abridged accounts)" if heading and not turnover else "")
        return out if out["check"] else None
    out.update(turnover=t, turnover_prior=tp)
    if t < MIN_TURNOVER:
        out.update(turnover=None, turnover_prior=None, check=f"turnover line read as {out['line']!r}: too small, "
                                                             f"likely a misread")
    elif c and c > t * 1.5:
        out.update(cost_of_sales=None, cost_of_sales_prior=None)   # bigger than turnover by half: a misread
    return out


# "Turnover for the year was £95.3m, compared with £104.2m", "Revenue for the year ended 30 June 2025 was
# £129,922,001 (2024: £126,778,008)", "Group turnover increased by 8% to £45.2 million (2024: £41.9 million)".
_PROSE = re.compile(
    r"\b((?:the\s+)?(?:group(?:'s|’s)?\s+|company(?:'s|’s)?\s+|total\s+)?(?:turnover|revenue|sales))"
    r"(?:\s+for\s+the\s+(?:year|period)[^.£]{0,45}?|\s+in\s+(?:the\s+year\s+)?20\d\d)?"
    r"\s+(?:was|were|of|amounted\s+to|totalled|totaled|(?:increased|decreased|rose|fell|grew)(?:\s+by\s+[\d.]+%)?\s+to)"
    r"\s+£\s?(\d[\d,]*(?:\.\d+)?)\s*(m\b|million\b|bn\b|billion\b)?"
    r"(?:[^.£]{0,40}?(?:\(\s*(?:20\d\d|prior\s+year|last\s+year)\s*[:-]?\s*|compared\s+(?:with|to)\s+|from\s+)"
    r"£\s?(\d[\d,]*(?:\.\d+)?)\s*(m\b|million\b|bn\b|billion\b)?)?", re.I)


def _money(number: str, unit: Optional[str]) -> float:
    value = float(number.replace(",", ""))
    unit = (unit or "").lower()
    return value * (1e9 if unit.startswith("b") else 1e6 if unit.startswith("m") else 1)


def from_prose(pages: list[str], first_page: int = 1) -> Optional[dict]:
    """
    Turnover stated in a sentence of the strategic report, when no statement
    could be read: {"turnover", "turnover_prior", "basis", "unit", "page",
    "line", "statement": False, "prose": True}, or None. Only "turnover /
    revenue [for the year] was / of / rose to £X" sentences; "turnover from
    Europe was …" (a part) doesn't match.
    """
    for n, page in enumerate(pages, first_page):
        flat = " ".join(page.split())
        for m in _PROSE.finditer(flat):
            value = _money(m.group(2), m.group(3))
            if value < MIN_TURNOVER:
                continue
            prior = _money(m.group(4), m.group(5) or m.group(3)) if m.group(4) else None
            return {"turnover": value, "turnover_prior": prior, "cost_of_sales": None, "cost_of_sales_prior": None,
                    "basis": "group" if "group" in m.group(1).lower() else "company", "unit": "£", "page": n,
                    "line": flat[m.start(): m.end()][:160], "check": "", "statement": False, "prose": True,
                    "years": []}
    return None


def read_document(text: str) -> Optional[dict]:
    """read() for one long text (a tagged filing): the statement's section first, page numbers left out."""
    sections, starts = statement_pages(text)
    found = [r for r in (read_page(sec, 0, statement=st) for sec, st in zip(sections, starts)) if r]
    with_turnover = [r for r in found if r["turnover"] is not None]
    if with_turnover:
        return min(with_turnover, key=lambda r: (not r["statement"], r["basis"] != "group"))
    return next((r for r in found if r["check"] and r["statement"]), None) or next((r for r in found if r["check"]), None)


def rescale(reading: Optional[dict], others: list[float]) -> Optional[dict]:
    """
    A statement read without a £ / £'000 / £m heading (OCR lost it) is taken as pounds; when the same accounts
    state turnover elsewhere (the strategic report's "sales totalled £355m", a KPI table in £m) at about a thousand
    or a million times it, the table was in £'000 / £m: its figures are scaled and the source says why. Nisbets'
    "Turnover 354,989" with "£355m" in the strategic report is £355.0m, not £355k. Never a guess: without such a
    figure (within 3%) the reading stays as it is.
    """
    if not reading or reading.get("turnover") is None or reading.get("unit_stated", True) or reading["unit"] != "£":
        return reading
    for factor, unit in ((1_000.0, "£'000"), (1_000_000.0, "£m")):
        match = next((o for o in others if o and abs(o / (reading["turnover"] * factor) - 1) <= 0.03), None)
        if match:
            for key in ("turnover", "turnover_prior", "cost_of_sales", "cost_of_sales_prior"):
                if reading.get(key) is not None:
                    reading[key] *= factor
            reading["unit"] = unit
            reading["line"] = f"{reading['line']} (in {unit}: the accounts state turnover as £{match / 1e6:,.1f}m elsewhere)"
            break
    return reading


def read(pages: list[str], first_page: int = 1, ocr: bool = False) -> Optional[dict]:
    """
    The best profit and loss reading across the pages: the primary statement's
    turnover (a consolidated one before the company's own), else the first
    turnover row anywhere (a note), else a "not disclosed" reading. None when
    no page has a turnover or gross-profit row.
    """
    found = [r for r in (read_page(p, n, ocr) for n, p in enumerate(pages, first_page)) if r]
    with_turnover = [r for r in found if r["turnover"] is not None]
    if with_turnover:
        best = min(with_turnover, key=lambda r: (not r["statement"], r["basis"] != "group", r["page"]))
        stated = [r["turnover"] for r in with_turnover if r is not best and r.get("unit_stated")]
        prose = from_prose(pages, first_page)
        return rescale(best, stated + ([prose["turnover"]] if prose else []))
    return next((r for r in found if r["check"]), None)


def describe(reading: dict) -> str:
    """Where the figure came from, for the turnover_source column: "accounts p12: group profit and loss, £'000"."""
    what = "group" if reading["basis"] == "group" else "company"
    where = ("strategic report" if reading.get("prose") else "profit and loss account" if reading["statement"]
             else "table in the accounts")
    page = f"accounts p{reading['page']}" if reading["page"] else "accounts"
    unit = "" if reading.get("prose") else f", {reading['unit']}"
    return f"{page}: {what} {where}{unit} — \"{reading['line']}\""
