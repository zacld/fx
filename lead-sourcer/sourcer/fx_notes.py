"""
sourcer/fx_notes.py — what a company's own accounts say about its currency
business, read from the document already downloaded (no extra calls, no AI):

  fx_currencies    currencies the accounts tie to the business: "principal exposures are to the US dollar and
                   euro", "purchases are made in euros", "sales invoiced in US dollars" (not every passing mention)
  fx_forwards      forward contracts with their size: "forward contracts to purchase US$5.2m (2023: US$3.1m)",
                   "fair value of forward contracts £45,000", a table row in the notes ("Derivative forward
                   contracts 43,393"), or the hedging reserve (the open hedges' value, when they hedge currency only)
  fx_balances      balances held in foreign currency: "trade debtors include £2.3m denominated in euros", or a
                   currency-profile table ("US dollar 1,234 / Euro 567")
  fx_sensitivity   the effect of a currency move: "a 10% weakening of sterling against the US dollar would have
                   reduced profit by £450,000"

Each item keeps the sentence (or table row) it came from and its page (0 when the document has no pages, a tagged
iXBRL filing), so the Accounts page can quote it and link to it. Nothing is converted or estimated: amounts are
shown in the currency the accounts give them in.

columns() turns them (with turnover by region, the FX gain/loss and how they handle FX today) into the row's
columns, and filed_proof() scores how much the filings themselves prove about the company's FX — the Accounts
page's "Hottest" order.
"""

from __future__ import annotations

import re
from typing import Optional

from sourcer import hooks, incumbent

# --- Amounts ---------------------------------------------------------------------------------------------------

_SYMBOLS = {"£": "GBP", "$": "USD", "€": "EUR", "US$": "USD", "U.S.$": "USD"}
_CODE_LIST = "GBP|USD|EUR|CNY|RMB|JPY|CHF|SEK|NOK|DKK|PLN|CAD|AUD|NZD|HKD|SGD|INR|ZAR|AED|TRY|CZK|HUF"
_MULT = {"m": 1e6, "mn": 1e6, "million": 1e6, "bn": 1e9, "billion": 1e9, "k": 1e3, "thousand": 1e3, "'000": 1e3,
         "’000": 1e3}
_NUM = r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?"
_MULT_RE = r"(?:\s?(?P<mult>m\b|mn\b|million\b|bn\b|billion\b|k\b|thousand\b|['’]000\b))?"
# "£5.2m", "US$3.1 million", "€2,500,000", "USD 3.1m", "$4m" (not "A$4m" / "HK$4m": other dollars)
_MONEY_RE = re.compile(
    rf"(?P<ccy>US\$|U\.S\.\$|£|€|(?<![A-Za-z])\$|\b(?:{_CODE_LIST})\b)\s?(?P<num>{_NUM}){_MULT_RE}", re.I)
# "5,000,000 euros", "3.1 million US dollars"
_MONEY_WORDS_RE = re.compile(
    rf"(?P<num>{_NUM}){_MULT_RE}\s+(?P<word>U\.?S\.?\s+dollars?|United\s+States\s+dollars?|euros?|Japanese\s+yen|"
    rf"Swiss\s+francs?|Chinese\s+(?:yuan|renminbi))\b", re.I)
_WORD_CODES = [(re.compile(r"dollar", re.I), "USD"), (re.compile(r"euro", re.I), "EUR"), (re.compile(r"yen", re.I), "JPY"),
               (re.compile(r"franc", re.I), "CHF"), (re.compile(r"yuan|renminbi", re.I), "CNY")]
_PRIOR_RE = re.compile(r"\(\s*(?:19|20)\d\d\s*[:\-–]|\b(?:19|20)\d\d\s*:\s*$|prior\s+year|previous\s+year|last\s+year", re.I)

SYMBOL = {"GBP": "£", "USD": "US$", "EUR": "€"}


def money(amount: float, ccy: str) -> str:
    """£5.2m / US$310k / €2,500 — rounded down, never up (hooks.short's rule), in the accounts' own currency."""
    text = hooks.short(amount).lstrip("£")
    sign = SYMBOL.get(ccy)
    return f"{sign}{text}" if sign else f"{ccy} {text}"


def amounts(sentence: str) -> list[dict]:
    """[{"amount", "ccy", "start", "end", "prior"}] for every money amount in a sentence, in order."""
    found = []
    for m in _MONEY_RE.finditer(sentence):
        raw = m.group("ccy").upper().replace(" ", "")
        ccy = _SYMBOLS.get(raw, _SYMBOLS.get(m.group("ccy"), raw))
        ccy = "CNY" if ccy == "RMB" else ccy
        found.append((m, ccy))
    for m in _MONEY_WORDS_RE.finditer(sentence):
        ccy = next(code for pattern, code in _WORD_CODES if pattern.search(m.group("word")))
        found.append((m, ccy))
    out = []
    for m, ccy in sorted(found, key=lambda x: x[0].start()):
        try:
            value = float(m.group("num").replace(",", ""))
        except ValueError:
            continue
        mult = (m.group("mult") or "").lower()
        value *= _MULT.get(mult, 1)
        before = sentence[max(0, m.start() - 16):m.start()]
        out.append({"amount": value, "ccy": ccy, "start": m.start(), "end": m.end(),
                    "prior": bool(_PRIOR_RE.search(before))})
    return out


# --- Sentences ---------------------------------------------------------------------------------------------------

# A sentence ends at ". " before a capital, a bracket or a numbered note heading ("creditors. 20.Other commitments").
_SENTENCE_END = re.compile(r"(?<=[.;])\s+(?=[A-Z(]|\d{1,2}\.\s?[A-Z])")
# A table row in layout text: a wide gap, then a figure ("Euro      567", "Turnover   3   45,123").
_TABULAR = re.compile(r"\S\s{3,}[(\-–]?[£$€]?\d")


def sentences(page: str) -> list[str]:
    """The prose sentences on a page: table rows and blank lines end a paragraph (a row is never read as prose)."""
    paragraphs, current = [], []
    for line in (page or "").split("\n"):
        if not line.strip() or _TABULAR.search(line):
            paragraphs.append(" ".join(current))
            current = []
        else:
            current.append(line)
    paragraphs.append(" ".join(current))
    out = []
    for paragraph in paragraphs:
        flat = " ".join(paragraph.split())
        out += [s.strip() for s in _SENTENCE_END.split(flat) if 20 <= len(s.strip()) <= 700]
    return out


def _codes(sentence: str) -> list[str]:
    """Foreign currencies named in a sentence (not sterling), in order, each once."""
    codes = [hooks._code_of(m) for m in hooks._CURRENCY_RE.finditer(sentence)]
    return list(dict.fromkeys(c for c in codes if c != "GBP"))


# Sentences that tie a currency to the business (not "transactions in foreign currencies are translated ...").
_TIED = re.compile(r"exposure|exposed|currency\s+risk|exchange\s+(?:rate\s+)?risk|denominated|principal(?:ly)?|"
                   r"mainly|primarily|predominantly|majority|significant\s+(?:portion|proportion|part)|"
                   r"purchases?\b|sales\b|invoiced|priced|paid\s+in|payments?\s+in|receipts?|income\s+in|suppliers?|"
                   r"customers?|hedg|forward|revenue\s+in|costs?\s+in|sourced", re.I)
_TRANSLATION_POLICY = re.compile(r"translated|retranslated|functional\s+(?:and\s+presentation\s+)?currency|"
                                 r"presentation\s+currency|closing\s+rate|average\s+rate|spot\s+rate", re.I)

_FORWARD_WORDS = re.compile(
    r"forward\s+(?:foreign\s+)?(?:exchange|currency|fx)\s+(?:contracts?|purchases?|sales?)|forward\s+contracts?|"
    r"(?:currency|fx|foreign\s+exchange)\s+forwards?|forward\s+(?:purchases?|cover)|"
    r"foreign\s+(?:exchange|currency)\s+contracts?|currency\s+(?:swaps?|options?)|"
    r"(?:fx|foreign\s+exchange|currency)\s+derivatives?", re.I)
_FAIR_VALUE_BEFORE = re.compile(r"fair\s+value|liabilit|\basset|carrying|valued\s+at|mark[- ]to[- ]market", re.I)
_GAIN_LOSS_BEFORE = re.compile(r"\b(?:gains?|loss(?:es)?|charged?|credit(?:ed)?)\b|recognised\s+in", re.I)
_GAIN_LOSS_AFTER = re.compile(r"^\s*(?:\([^)]*\)\s*)?(?:gains?|loss(?:es)?)\b", re.I)
_BUY = re.compile(r"purchas|\bbuy|\bbought", re.I)
_SELL = re.compile(r"\bsell|\bsales?\b|\bsold\b", re.I)

_BALANCE_WORDS = re.compile(r"denominated\s+in|held\s+in\s+(?:foreign|[A-Z]|US|euro)|in\s+foreign\s+currenc|"
                            r"foreign\s+currency\s+(?:balances|denominated|debtors|creditors|cash|bank)", re.I)
_BALANCE_KIND = [(re.compile(r"debtor|receivable", re.I), "receivables"), (re.compile(r"creditor|payable", re.I), "payables"),
                 (re.compile(r"cash|bank\s+balances?|deposits?", re.I), "cash"),
                 (re.compile(r"borrowing|loans?\b|overdraft", re.I), "borrowings")]

_SENSITIVITY = re.compile(r"(\d{1,2}(?:\.\d+)?)\s?(?:%|per\s?cent)", re.I)
_MOVE_WORDS = re.compile(r"strengthen|weaken|appreciat|depreciat|increase|decrease|\brise\b|\bfall\b|movement|change", re.I)
_EFFECT_WORDS = re.compile(r"profit|loss|equity|result|income|earnings|reserves", re.I)
_STERLING = re.compile(r"sterling|\bpound|\bGBP\b|exchange\s+rates?", re.I)


def _negated(sentence: str, start: int) -> bool:
    return bool(incumbent._NEGATED_BEFORE.search(sentence[max(0, start - 60):start]))


# Contracts or a fair value under this are too small to open a call on (and usually a misread).
MIN_FORWARD_AMOUNT = 5_000
_PNL_EFFECT = re.compile(r"taken\s+to\s+the|recognised\s+in\s+(?:the\s+)?(?:profit|statement|income)|"
                         r"(?:credited|charged)\s+to|(?:fair\s+value\s+)?(?:profit|gain|loss)\s+on\s+(?:the\s+)?"
                         r"(?:forward|foreign|derivative|revaluation)", re.I)
_NUMBER_TOKEN = re.compile(r"(?<![\w.])\(?[£$€]?\d[\d,]*(?:\.\d+)?\)?(?![\w])")
# Dates ("29/12/2025"), exchange rates ("at a rate of 1.338116") and years: figures, but not amounts.
_NOT_AMOUNTS = re.compile(r"\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d+\.\d{3,}\b|\b(?:19|20)\d\d\b")
_THESE_CONTRACTS = re.compile(r"\b(?:these|the|such|open|outstanding)\s+(?:forward\s+)?contracts?\b|"
                             r"\bcontracts?\s+(?:outstanding|in\s+place|open)\b", re.I)


def _in_brackets_about_another_year(sentence: str, start: int) -> bool:
    """An amount inside "(2024: £3.1m)" / "(At 31 December 2024, there were … €2.4m)": last year's figure."""
    opened = sentence.rfind("(", 0, start)
    if opened < 0 or ")" in sentence[opened:start]:
        return False
    return bool(re.search(r"(?:19|20)\d\d|prior|previous|last\s+year|comparative", sentence[opened:start], re.I))


def _forward_items(sentence: str, page: int, follows_forward: bool = False) -> list[dict]:
    """
    Forward contracts' sizes in a sentence that names them — or, right after one that does, says "these contracts"
    ("The company enters into forward contracts … At the year end it had outstanding contracts of $1.2m").
    """
    m = _FORWARD_WORDS.search(sentence) or (_THESE_CONTRACTS.search(sentence) if follows_forward else None)
    if not m or _negated(sentence, m.start()) or incumbent._POLICY_DEFINITION.search(sentence):
        return []
    if _PNL_EFFECT.search(sentence):
        return []   # "the fair value profit … taken to the statement of comprehensive income": a P&L effect, not a size
    if len(_NUMBER_TOKEN.findall(_NOT_AMOUNTS.sub(" ", sentence))) > 6:
        return []   # table rows run together (OCR / layout): their figures belong to other lines
    if _FORWARD_WORDS.search(sentence) and not incumbent._EXPLICIT_FX_FORWARD.search(m.group(0)) and (
            not incumbent._FX_CONTEXT.search(sentence) or incumbent._NON_FX_FORWARD.search(sentence)):
        return []   # a bare "forward contracts" for freight or materials
    direction = "buy" if _BUY.search(sentence) and not _SELL.search(sentence) else \
        "sell" if _SELL.search(sentence) and not _BUY.search(sentence) else ""
    items: list[dict] = []
    for a in amounts(sentence):
        if a["end"] < m.start() - 100:
            continue   # well before the contracts are named: another fact run into the sentence
        before = sentence[max(0, a["start"] - 120):a["start"]]
        if (_GAIN_LOSS_BEFORE.search(before) and not _FAIR_VALUE_BEFORE.search(before)) or \
                _GAIN_LOSS_AFTER.search(sentence[a["end"]:a["end"] + 30]):
            continue   # a gain or loss on the contracts ("a loss of £120,000 on …", "£120,000 loss"), not their size
        what = "fair value" if _FAIR_VALUE_BEFORE.search(before) else "contracts"
        if a["prior"] or _in_brackets_about_another_year(sentence, a["start"]):
            same = next((i for i in reversed(items) if i["what"] == what and i.get("prior") is None), None)
            if same:
                same["prior"] = a["amount"]
            continue
        if a["amount"] < MIN_FORWARD_AMOUNT:
            continue
        items.append({"what": what, "amount": a["amount"], "ccy": a["ccy"], "direction": direction, "prior": None,
                      "sentence": hooks._sentence(sentence, a["start"], a["end"], limit=320), "page": page})
    return items[:2]


def _balance_items(sentence: str, page: int) -> list[dict]:
    if not _BALANCE_WORDS.search(sentence) or _TRANSLATION_POLICY.search(sentence):
        return []
    codes = _codes(sentence)
    kind = next((k for pattern, k in _BALANCE_KIND if pattern.search(sentence)), "")
    out = []
    for a in amounts(sentence):
        if a["prior"] or a["amount"] < 1_000:
            continue
        out.append({"what": kind, "amount": a["amount"], "ccy": a["ccy"],
                    "in": codes[0] if codes else ("" if a["ccy"] == "GBP" else a["ccy"]),
                    "sentence": hooks._sentence(sentence, a["start"], a["end"], limit=320), "page": page})
        break
    return out


_FX_MOVE = re.compile(r"strengthen|weaken|appreciat|depreciat|(?:exchange\s+rates?|sterling|currenc\w*|"
                      r"pound|dollar|euro)\W+(?:\w+\W+){0,4}?(?:movement|change|increase|decrease|rise|fall|move)|"
                      r"(?:movement|change|increase|decrease|rise|fall|move)\w*\s+(?:\w+\s+){0,3}?in\s+(?:the\s+)?"
                      r"(?:exchange\s+rates?|sterling|value\s+of\s+sterling|currenc)", re.I)
_GROWTH = re.compile(r"\b(?:increased|grew|rose|decreased|fell|up|down)\s+(?:by\s+)?(?:\d{1,3}(?:\.\d+)?\s?%)\s+to\b", re.I)


def _sensitivity_items(sentence: str, page: int) -> list[dict]:
    pct = _SENSITIVITY.search(sentence)
    if not pct or not _FX_MOVE.search(sentence) or _GROWTH.search(sentence) or not _EFFECT_WORDS.search(sentence):
        return []   # "revenue increased by 25% to €157m" is growth, not a currency move's effect
    codes = _codes(sentence)
    if not codes and not _STERLING.search(sentence):
        return []
    found = [a for a in amounts(sentence) if not a["prior"] and a["amount"] >= 1_000]
    if not found:
        return []
    a = found[0]
    return [{"pct": float(pct.group(1)), "codes": codes, "amount": a["amount"], "ccy": a["ccy"],
             "sentence": hooks._sentence(sentence, a["start"], a["end"], limit=320), "page": page}]


# --- Tables (PDF layout text / a tagged filing laid out as rows) ---------------------------------------------------

_THOUSANDS = re.compile(r"£\s*['’`]?\s*000|£\s*k\b|£\s*thousands?", re.I)
_MILLIONS = re.compile(r"£\s*['’`]?\s*m\b|£\s*millions?", re.I)
_CELL = re.compile(r"\(?-?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?|\(?-?\d+(?:\.\d+)?\)?")
_YEAR = re.compile(r"(?:19|20)\d\d")
_FORWARD_ROW = re.compile(r"^\s*((?:Forward\s+)?(?:foreign\s+)?(?:exchange|currency)\s+(?:forward\s+)?contracts?|"
                          r"(?:Derivative\s+)?forward\s+contracts?|"
                          r"Forward\s+(?:foreign\s+)?(?:exchange|currency)\s+contracts?|Currency\s+forwards?|"
                          r"Foreign\s+exchange\s+forwards?|Derivative\s+financial\s+instruments?\s*[-–—(]\s*"
                          r"(?:foreign\s+exchange|currency)[^\n]{0,30}?)\s+(.*)$", re.I | re.M)
_PROFILE_HEADING = re.compile(r"currency\s+profile|denominated\s+in\s+the\s+following\s+currencies|"
                              r"(?:analysed|analysis)\s+by\s+currency|by\s+currency\s+(?:of\s+denomination)?|"
                              r"foreign\s+currency\s+(?:denominated\s+)?(?:balances|exposures?)", re.I)
_PROFILE_ROW = re.compile(r"^\s*(US\s+dollars?|U\.S\.\s+dollars?|Euros?|Japanese\s+yen|Swiss\s+francs?|"
                          r"Chinese\s+(?:yuan|renminbi)|Canadian\s+dollars?|Australian\s+dollars?|Hong\s+Kong\s+dollars?|"
                          r"Swedish\s+kron(?:a|or)|Norwegian\s+kron(?:e|er)|Danish\s+kron(?:e|er)|Polish\s+zloty|"
                          r"Indian\s+rupees?|South\s+African\s+rand|Singapore\s+dollars?|New\s+Zealand\s+dollars?|"
                          r"(?:USD|EUR|CNY|RMB|JPY|CHF|SEK|NOK|DKK|PLN|CAD|AUD|NZD|HKD|SGD|INR|ZAR|AED))\b(.*)$",
                          re.I | re.M)


def _scale_near(page: str, at: int, after: int = 0) -> float:
    """
    The £'000 / £m heading nearest above a table row (within the 2,500 characters before it, or the `after`
    characters following, a column heading under the table's title), else £1.
    """
    window = page[max(0, at - 2500):at + after]
    marks = [(m.end(), 1_000.0) for m in _THOUSANDS.finditer(window)] + \
            [(m.end(), 1_000_000.0) for m in _MILLIONS.finditer(window)]
    return max(marks)[1] if marks else 1.0


def _cells(rest: str) -> list[float]:
    """The figures in a table row's cells: years and "note 21" left out, and a leading note-number column too."""
    rest = re.sub(r"\(?\bnotes?\s*\d+\)?", " ", rest, flags=re.I)
    values = []
    for token in _CELL.findall(rest):
        if _YEAR.fullmatch(token.strip("()-")):
            continue
        negative = token.startswith(("(", "-"))
        try:
            value = float(re.sub(r"[^\d.]", "", token))
        except ValueError:
            continue
        values.append(-value if negative else value)
    first = _CELL.findall(rest)[:1]
    if len(values) > 2 and first and re.fullmatch(r"\d{1,2}", first[0]):
        values = values[1:]   # "Forward contracts   21   12,345   10,000": 21 is the note
    return values


def _row_text(line: str) -> str:
    return " ".join(line.split())[:200]


_ROW_GAIN_LOSS = re.compile(r"(?:gains?|loss(?:es)?|profit|movement|charge|credit)(?:\s+on)?(?:\s+derivative)?\s*$",
                            re.I)


def _forward_rows(page: str, number: int) -> list[dict]:
    out = []
    for m in _FORWARD_ROW.finditer(page):
        rest = m.group(2)
        if len(re.findall(r"[A-Za-z]{3,}", rest)) > 2:
            continue   # prose, not a table row
        before = page[max(0, m.start() - 60):m.start()].rstrip()
        if _ROW_GAIN_LOSS.search(before.split("\n")[-1]):
            continue   # "Loss on derivative ⏎ forward contracts (1,984)": the P&L line, not the contracts
        if not re.match(r"\s*(?:foreign|exchange|currency|forward\s+(?:foreign|exchange|currency))", m.group(1), re.I) \
                and not re.search(r"forward\s+(?:foreign\s+)?(?:exchange|currency)|currency\s+forwards?", page, re.I):
            continue   # a bare "forward contracts" row on a page that never ties them to currency
        values = [v for v in _cells(rest) if abs(v) > 0]
        if not values:
            continue
        scale = _scale_near(page, m.start())
        amount = abs(values[0]) * scale
        if amount < MIN_FORWARD_AMOUNT:
            continue
        out.append({"what": "table", "amount": amount, "ccy": "GBP", "direction": "",
                    "prior": abs(values[1]) * scale if len(values) > 1 else None,
                    "sentence": _row_text(m.group(0)), "page": number})
        break
    return out


_HEDGE_RESERVE_ROW = re.compile(r"^\s*((?:Cash\s*flow\s+)?hedg(?:e|ing)\s+reserve)\s+(.*)$", re.I | re.M)
_INTEREST_HEDGE = re.compile(r"interest\s+rate\s+(?:swaps?|caps?|collars?|hedg|derivatives?)", re.I)


def _hedge_reserve_rows(page: str, number: int, document: str) -> list[dict]:
    """
    "Hedging reserve 20 710,411 (537,081)": the fair value of the open cash-flow hedges — a size for the forward
    book when the accounts hedge currency with forwards and nothing else (no interest rate swaps).
    """
    if _INTEREST_HEDGE.search(document) or not re.search(
            r"forward\s+(?:foreign\s+)?(?:exchange|currency)|currency\s+forwards?|foreign\s+exchange\s+contracts?",
            document, re.I):
        return []
    for m in _HEDGE_RESERVE_ROW.finditer(page):
        rest = m.group(2)
        if len(re.findall(r"[A-Za-z]{3,}", rest)) > 1:
            continue
        values = [v for v in _cells(rest) if abs(v) > 0]
        if not values:
            continue
        scale = _scale_near(page, m.start())
        amount = abs(values[0]) * scale
        if amount < MIN_FORWARD_AMOUNT:
            continue
        return [{"what": "hedge reserve", "amount": amount, "ccy": "GBP", "direction": "",
                 "prior": abs(values[1]) * scale if len(values) > 1 else None,
                 "sentence": _row_text(m.group(0)), "page": number}]
    return []


def _profile_rows(page: str, number: int) -> list[dict]:
    heading = _PROFILE_HEADING.search(page)
    if not heading:
        return []
    block_start = heading.end()
    block = "\n".join(page[block_start:].split("\n")[:30])
    first_row = _PROFILE_ROW.search(block)
    scale = _scale_near(page, block_start, after=first_row.start() if first_row else 0)
    out = []
    for m in _PROFILE_ROW.finditer(block):
        rest = m.group(2)
        if len(re.findall(r"[A-Za-z]{3,}", rest)) > 2:
            continue
        values = [v for v in _cells(rest) if abs(v) > 0]
        codes = _codes(m.group(1)) or [m.group(1).upper()[:3].replace("RMB", "CNY")]
        if values and codes and codes[0] != "GBP" and abs(values[0]) * scale >= 1_000:
            out.append({"what": "currency profile", "amount": abs(values[0]) * scale, "ccy": "GBP", "in": codes[0],
                        "sentence": _row_text(m.group(0)), "page": number})
    return out[:6]


# --- Reading a document ----------------------------------------------------------------------------------------------

# Wording that makes a currency the business's own: its principal exposure, what it buys or sells in.
_STRONG = re.compile(r"principal|exposure|exposed|mainly|primarily|predominantly|majority|invoiced|denominated|"
                     r"purchases?\s+(?:are|were)?\s*(?:made|priced|invoiced)?\s*in|sales\s+(?:are|were)?\s*"
                     r"(?:made|priced|invoiced)?\s*in", re.I)


def read(pages: list[str], numbers: Optional[list[int]] = None, table_pages: Optional[list[str]] = None) -> dict:
    """
    The fx_* facts from an accounts document's text, one string per page; `numbers` the pages' numbers (default
    1, 2, …; 0 = no page, a tagged filing). Table rows are read from `table_pages` when given (a tagged filing laid
    out as rows by accounts.ixbrl_table_text), else from the pages. Only the first few of each kind are kept.
    """
    numbers = numbers if numbers is not None else list(range(1, len(pages) + 1))
    currencies: dict[str, dict] = {}
    forwards: list[dict] = []
    balances: list[dict] = []
    sensitivity: list[dict] = []
    for page, number in zip(pages, numbers):
        follows_forward = False
        for s in sentences(page):
            codes = _codes(s)
            if codes and _TIED.search(s) and not _TRANSLATION_POLICY.search(s):
                buys, sells = hooks._direction(s)
                strength = 2 if _STRONG.search(s) else 1
                for code in codes:
                    entry = currencies.setdefault(code, {"code": code, "count": 0, "buys": False, "sells": False,
                                                          "sentence": "", "page": number, "strength": 0})
                    entry["count"] += strength
                    entry["buys"] |= buys
                    entry["sells"] |= sells
                    if (strength, -len(s)) > (entry["strength"], -len(entry["sentence"] or s * 2)):
                        entry.update(sentence=hooks._sentence(s, 0, 0, limit=320), page=number, strength=strength)
            if len(forwards) < 4:
                forwards += _forward_items(s, number, follows_forward)
            follows_forward = bool(_FORWARD_WORDS.search(s))
            if len(balances) < 4:
                balances += _balance_items(s, number)
            if len(sensitivity) < 3:
                sensitivity += _sensitivity_items(s, number)
    tables = table_pages if table_pages is not None else pages
    document = "\n".join(tables)
    for page, number in zip(tables, numbers):
        if not any(f["what"] == "table" for f in forwards):
            forwards += _forward_rows(page, number)
        if not any(f["what"] == "hedge reserve" for f in forwards):
            forwards += _hedge_reserve_rows(page, number, document)
        if len(balances) < 6:
            balances += _profile_rows(page, number)
    for f in forwards:   # a currency they hold forwards in is one they deal in
        if f["ccy"] in currencies:
            currencies[f["ccy"]]["count"] += 2
    ranked = sorted(currencies.values(), key=lambda c: (-c["count"], c["code"]))
    for c in ranked:
        c.pop("strength", None)
    return {"fx_currencies": ranked[:6], "fx_forwards": forwards[:4], "fx_balances": balances[:6],
            "fx_sensitivity": sensitivity[:3]}


EMPTY = {"fx_currencies": [], "fx_forwards": [], "fx_balances": [], "fx_sensitivity": []}


def merge(facts: dict, more: dict) -> dict:
    """Adds `more`'s fx_* items (pages OCR'd later) to `facts`, keeping what was already found first."""
    for key in EMPTY:
        have = facts.get(key) or []
        seen = {(i.get("code"), i.get("sentence")) for i in have}
        facts[key] = have + [i for i in more.get(key) or [] if (i.get("code"), i.get("sentence")) not in seen]
    return facts


# --- Columns ---------------------------------------------------------------------------------------------------------

COLUMNS = ["filed_fx_score", "filed_fx", "currencies_in_accounts", "currencies_in_accounts_evidence",
           "fx_forwards", "fx_forwards_evidence", "fx_balances", "fx_sensitivity", "turnover_regions",
           "fx_notes_url", "turnover_regions_url"]

# How much each fact in the company's own filings proves about its FX business (the Accounts page's "Hottest"
# order, and part of the finder's ranking). Tune against real call outcomes; every row lists what it scored.
FILED_FX_POINTS = {
    "forwards_amount": 40,    # forward contracts with a size: they buy/sell currency forward today
    "fx_provider": 30,        # an FX provider named, or holding a charge
    "hedging_policy": 20,     # how they handle FX in their own words (forwards / options / no hedging / natural hedge)
    "sensitivity": 25,        # the effect of a currency move on profit
    "fx_gain_loss_big": 25,   # FX gain/loss of £50k+ (hooks.HOOK_RULES["fx_gain_loss_min_gbp"])
    "fx_gain_loss": 10,       # a smaller FX gain/loss
    "regions": 20,            # turnover by region with a non-UK region
    "currencies": 15,         # currencies tied to the business in the accounts
    "balances": 15,           # balances held in foreign currency
}


def _where(page: int, source: str) -> str:
    return f"{source}, p{page}" if page else source


def _forward_line(f: dict) -> str:
    size = money(f["amount"], f["ccy"])
    prior = f" (prior year {money(f['prior'], f['ccy'])})" if f.get("prior") else ""
    if f["what"] == "fair value":
        return f"forward contracts valued at {size}{prior}"
    if f["what"] == "table":
        return f"forward contracts {size} in the notes' tables{prior}"
    if f["what"] == "hedge reserve":
        return f"hedging reserve {size} (the open currency hedges' value){prior}"
    verb = {"buy": "to buy ", "sell": "to sell "}.get(f.get("direction", ""), "of ")
    return f"forward contracts {verb}{size}{prior}"


def _balance_line(b: dict) -> str:
    what = f"{b['what']} " if b.get("what") and b["what"] != "currency profile" else ""
    held = f" in {b['in']}" if b.get("in") and b["in"] != b["ccy"] else ""
    return f"{what}{money(b['amount'], b['ccy'])}{held}".strip()


def _page_url(accounts_url: str, page: int, fmt: str) -> str:
    if not accounts_url:
        return ""
    return f"{accounts_url}#page={page}" if page and fmt in ("pdf", "scanned pdf") else accounts_url


def columns(facts: Optional[dict], company_name: str, accounts_url: str = "") -> dict:
    """The fx_* facts and turnover by region as row columns, each with its source (blank when the accounts are silent)."""
    f = facts or {}
    source = hooks._source_accounts(f).replace(", tagged figure", "")
    fmt = f.get("format", "")
    out = {k: "" for k in COLUMNS if k not in ("filed_fx_score", "filed_fx")}

    own = hooks._drop_own_name([{"code": c["code"], "sentence": c["sentence"]} for c in f.get("fx_currencies") or []],
                               company_name)
    kept = [c for c in f.get("fx_currencies") or [] if any(o["code"] == c["code"] for o in own)]
    if kept:
        out["currencies_in_accounts"] = ", ".join(c["code"] + (" (buys)" if c["buys"] and not c["sells"] else
                                                               " (sells)" if c["sells"] and not c["buys"] else "")
                                                  for c in kept[:4])
        best = kept[0]
        out["currencies_in_accounts_evidence"] = f"\"{best['sentence']}\" ({_where(best['page'], source)})"

    forwards = f.get("fx_forwards") or []
    if forwards:
        out["fx_forwards"] = "; ".join(dict.fromkeys(_forward_line(x) for x in forwards[:2]))
        out["fx_forwards"] = out["fx_forwards"][0].upper() + out["fx_forwards"][1:]
        out["fx_forwards_evidence"] = " | ".join(f"\"{x['sentence']}\" ({_where(x['page'], source)})" for x in forwards[:2])
    balances = f.get("fx_balances") or []
    if balances:
        out["fx_balances"] = "; ".join(dict.fromkeys(_balance_line(b) for b in balances[:4])) + \
            f" ({_where(balances[0]['page'], source)})"
    sens = (f.get("fx_sensitivity") or [None])[0]
    if sens:
        against = f" against {', '.join(sens['codes'][:2])}" if sens["codes"] else ""
        out["fx_sensitivity"] = (f"{sens['pct']:g}% move in sterling{against}: {money(sens['amount'], sens['ccy'])} "
                                 f"on profit — \"{sens['sentence']}\" ({_where(sens['page'], source)})")
    regions = [r for r in f.get("regions") or [] if r.get("value")]
    if regions:
        out["turnover_regions"] = " · ".join(f"{r['region']} {hooks.short(r['value'])}" for r in regions[:6])
        out["turnover_regions_url"] = _page_url(accounts_url, f.get("regions_page") or 0, fmt)
    first = next((x for x in forwards + balances + [sens] + [c for c in kept] if x), None)
    if first:
        out["fx_notes_url"] = _page_url(accounts_url, first.get("page") or 0, fmt)
    return out


def filed_proof(row: dict) -> tuple[int, list[str]]:
    """
    (score, what scored) from what the company's own filings say about its FX: the row's columns from
    columns() above, incumbent.columns() (fx_today) and the FX gain/loss. Customs records and niche don't count
    here: they're in fx_evidence_score.
    """
    p, lines = FILED_FX_POINTS, []

    def add(key: str, line: str) -> None:
        lines.append(f"{line} (+{p[key]})")

    fwd = row.get("fx_forwards") or ""
    today = row.get("fx_today") or ""
    if fwd:
        add("forwards_amount", fwd)
    if today.startswith("Uses an FX provider"):
        add("fx_provider", today)
    elif today and not fwd:
        add("hedging_policy", today)
    if row.get("fx_sensitivity"):
        add("sensitivity", "currency sensitivity disclosed")
    fx = row.get("fx_gain_loss_gbp") or ""
    try:
        value = float(fx) if fx != "" else None
    except ValueError:
        value = None
    if value is not None:
        big = abs(value) >= hooks.HOOK_RULES["fx_gain_loss_min_gbp"]
        add("fx_gain_loss_big" if big else "fx_gain_loss",
            f"FX {'loss' if value < 0 else 'gain'} {hooks.short(abs(value))}")
    regions = row.get("turnover_regions") or ""
    if regions and any(not hooks.is_uk(part.rsplit(" ", 1)[0]) for part in regions.split(" · ")):
        add("regions", "turnover by region")
    if row.get("currencies_in_accounts"):
        add("currencies", f"currencies in the accounts: {row['currencies_in_accounts']}")
    if row.get("fx_balances"):
        add("balances", "foreign-currency balances")
    return sum(int(re.search(r"\(\+(\d+)\)$", line).group(1)) for line in lines), lines
