"""
sourcer/fx_text.py — the foreign-exchange gain/loss line read from accounts
text: untagged lines in iXBRL accounts (Wanis, 7 of 11 tagged filings without
an FX figure in the case study) and PDF / OCR text of scanned filings.

The line usually sits in the operating-profit note ("Operating profit is
stated after charging/(crediting): ... Exchange losses/(gains) 52,195
(25,479)"): this year's figure, then last year's. Which way it went comes
from the label ("losses/(gains)": a bracketed figure is a gain), else from
the note's heading ("after charging": an unbracketed figure is a charge, so
a loss). When neither says, the size is reported as a check, not a fact.

Real lines behind every rule are in tests/test_fx_cases.py.
"""

from __future__ import annotations

import re
from typing import Optional

# "Exchange differences", "Foreign exchange losses/(gains)", "Net foreign exchange (gains)/losses",
# "Exchange gains", "Profit/loss on exchange", "Differences on foreign exchange", "(Gain)/loss on foreign exchange".
_LABEL = re.compile(
    r"(?<![A-Za-z])((?:net\s+)?(?:foreign\s+)?(?:exchange|currency)\s+(?:rate\s+)?"
    r"(?:\(?gains?\)?\s*/\s*\(?loss(?:es)?\)?|\(?loss(?:es)?\)?\s*/\s*\(?gains?\)?|differences?|gains?|loss(?:es)?)"
    r"|(?:\(?profit\)?|\(?gains?\)?)\s*/\s*\(?loss\)?\s+on\s+(?:foreign\s+)?(?:exchange|currency)"
    r"|differences\s+on\s+foreign\s+exchange)",
    re.I)
# OCR and layout debris allowed between the label and the figures: ", ", " : ", " ° ", "_".
_GAP = r"[\s:;,.°'\"_~|]{0,8}"
# A figure: "52,195", "52195", "(25,479)", "-12,345", "1.2" (£m tables), "52.195" (OCR's comma as a full stop).
_DIGITS = r"(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
_NUMBER = rf"\(\s?-?{_DIGITS}\s?\)|-?{_DIGITS}"
_ROW = re.compile(_LABEL.pattern + rf"{_GAP}({_NUMBER})(?:{_GAP}({_NUMBER}|-|–|—))?(?![\d,])", re.I)
# Lines that look like the label but are something else.
_NOT_PL = re.compile(r"translation|reserve|comprehensive|consolidation|futures|contracts|cash.?pool|hedg", re.I)
_YEAR = re.compile(r"^(?:19|20)\d\d$")          # a bare column year, "2025"; "2,019" is a figure
_OCR_THOUSANDS = re.compile(r"^\d{1,3}(?:\.\d{3})+$")   # "52.195": a comma OCR read as a full stop
_CHARGING = re.compile(r"after\s+charging|charging\s*/\s*\(?crediting|\(crediting\)", re.I)
_CREDITING = re.compile(r"after\s+crediting", re.I)
# Table headings that set the scale or say the figures aren't in pounds.
# "£'000", "£000", "£'000s", "£m", "£ million", "$'000", "€'000" standing alone (not "£45m" in a sentence),
# or a bare symbol repeated for the columns ("£ £", "$ $"). A single "US$" or "£" in prose isn't a heading.
_HEADING = re.compile(
    r"(US\$|£|\$|€)(?:\s*['’`]?\s*(000s?|thousands?|millions?|m|k)(?![\w,.])|(?=\s+(?:US\$|£|\$|€)(?![\w,.'’`])))",
    re.I)


def _value(token: str, millions: bool = False) -> Optional[float]:
    """The size of a figure (no sign); None for a column year or junk."""
    token = token.strip()
    if token in ("-", "–", "—"):
        return 0.0
    bare = re.sub(r"[()\s-]", "", token)
    if _YEAR.match(bare):
        return None
    if _OCR_THOUSANDS.match(bare) and not millions:
        bare = bare.replace(".", "")   # "52.195" in a £ or £'000 table is 52,195
    digits = re.sub(r"[^\d.]", "", bare)
    try:
        return float(digits) if digits else None
    except ValueError:
        return None


def _negative(token: str) -> bool:
    """Shown in brackets or with a minus: the other way from the column's plain figures."""
    token = token.strip()
    return token.startswith("(") or (token.startswith("-") and token not in ("-", "–", "—"))


def _direction(label: str, context: str) -> Optional[str]:
    """
    How to read an unbracketed figure: "loss" or "gain" (bracketed figures
    read the other way), "gain only" / "loss only" when the label names one
    side (brackets ignored), None when nothing says.
    """
    lab = label.lower()
    gain, loss = "gain" in lab or "profit" in lab, "loss" in lab
    if gain and loss:
        # "losses/(gains)", "(gains)/losses": the bracketed word is what a bracketed figure is.
        bracketed_gain = re.search(r"\(\s*(?:gains?|profit)\s*\)", lab) is not None
        bracketed_loss = re.search(r"\(\s*loss(?:es)?\s*\)", lab) is not None
        if bracketed_gain and not bracketed_loss:
            return "loss"
        if bracketed_loss and not bracketed_gain:
            return "gain"
        # "Profit/loss on exchange": no brackets in the label, the note's heading decides.
    elif gain:
        return "gain only"   # "Exchange gains (4,365)": brackets only mean credited in that note
    elif loss:
        return "loss only"
    if _CHARGING.search(context):
        return "loss"   # charged = expense; a bracketed figure was credited
    if _CREDITING.search(context):
        return "gain"
    return None


def _scale(before: str) -> tuple[float, str]:
    """(multiplier, currency) from the nearest table heading before the line: £'000 -> 1000, $'000 -> dollars."""
    last = None
    for m in _HEADING.finditer(before):
        last = m
    if not last:
        return 1.0, "£"
    symbol = last.group(1).upper().replace("US$", "$")
    unit = (last.group(2) or "").lower()
    if unit.startswith(("000", "k", "thousand")):
        return 1_000.0, symbol
    return (1_000_000.0 if unit.startswith("m") else 1.0), symbol


def read(text: str, scale_text: Optional[str] = None, ocr: bool = False) -> Optional[dict]:
    """
    The first FX gain/loss line in `text`: {"value", "prior", "label",
    "line", "check"}. value/prior in £, + gain / - loss; None for prior when
    there is no second column. check is "" for a usable figure, else why it
    isn't one (direction not stated, figures not in pounds). None when
    there is no such line. `scale_text` is the text whose headings set the
    scale (a PDF page); by default the 2,000 characters before the line.
    """
    # Table cells come with indentation and line breaks between them (iXBRL markup, pdftotext -layout columns).
    text = re.sub(r"[^\S\n]+", " ", re.sub(r"\s*\n\s*", "\n", text))
    for m in _ROW.finditer(text):
        label, first, second = " ".join(m.group(1).split()), m.group(2), m.group(3)
        before = text[max(0, m.start() - 2_000):m.start()]
        # "Currency translation differences", "Fair value gains on exchange rate futures": not the P&L line.
        if _NOT_PL.search(label) or _NOT_PL.search(before[-40:].split("\n")[-1]):
            continue
        multiplier, currency = _scale(scale_text if scale_text is not None else before)
        current = _value(first, millions=multiplier == 1_000_000)
        if current is None:
            continue
        if ocr and currency == "$" and ("£" in text or not re.search(r"US\$|USD|dollar", text, re.I)):
            currency = "£"   # OCR often reads "£" as "$": only a page that says dollars and never £ is in dollars
        context = (scale_text if scale_text is not None else before)[-1_500:]
        direction = _direction(label, context)
        line = " ".join(text[m.start():m.end()].split())

        def signed(token: str, amount: float) -> float:
            if amount == 0:
                return 0.0
            if direction.endswith(" only"):
                loss = direction == "loss only"
            else:
                loss = (direction == "loss") != _negative(token)
            return -amount * multiplier if loss else amount * multiplier

        prior_amount = _value(second, millions=multiplier == 1_000_000) if second else None
        check = ""
        if currency != "£":
            check = f'FX line "{line}" is in {currency}, not pounds; check the accounts'
        elif direction is None:
            check = f'FX line "{line}" doesn\'t say gain or loss; check the accounts'
        return {
            "value": signed(first, current) if direction else None,
            "prior": signed(second, prior_amount) if direction and prior_amount is not None else None,
            "size": current * multiplier,
            "label": label,
            "line": line,
            "check": check,
        }
    return None


def row_label(before: str) -> str:
    """The words of a tagged figure's row: the last run of text with letters between figures."""
    for part in reversed(re.split(_NUMBER, before[-200:])):
        if re.search(r"[A-Za-z]{3,}", part):
            return " ".join(part.split()).strip(" (")
    return ""


def label_is_fx(before: str) -> bool:
    """Whether a tagged FX figure's row (the text just before it) is about exchange or currency."""
    return re.search(r"exchange|currenc|\bforex\b|\bFX\b", row_label(before), re.I) is not None


def foreign_heading(before: str) -> Optional[str]:
    """"$" / "€" when the table heading nearest before a tagged figure is in dollars / euros (no £ after it)."""
    _, currency = _scale(before[-400:])
    return None if currency == "£" else currency
