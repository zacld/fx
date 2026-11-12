"""
sourcer/deals.py — buying companies and new finance directors, read from a filing's own text (the FX filings scan
already has it). Triggers, not finances: who the company bought in the year, and directors appointed — the finance
director or CFO when the accounts give the title.

    acquisitions(text) -> [{"name", "abroad", "sentence"}]       "acquired the entire issued share capital of X GmbH"
    finance_appointments(text) -> [{"when", "sentence"}]         "J Smith — Finance Director (appointed 3 March 2026)"
"""

from __future__ import annotations

import re

_ENTITY = (r"(?:Limited|Ltd\.?|LLP|PLC|plc|GmbH|AG|B\.?V\.?|N\.?V\.?|S\.?A\.?S?|S\.?r\.?l\.?|S\.?p\.?A\.?|S\.?L\.?U?|"
           r"Inc\.?|LLC|Corp(?:oration)?\.?|Pty\.? Ltd|Pte\.? Ltd|AB|A/S|ApS|Oy|AS|Sp\. z o\.o\.|K\.?K\.?|Kft\.?|SE)")
FOREIGN = re.compile(r"\b(?:GmbH|AG|B\.?V\.?|N\.?V\.?|S\.?A\.?S?|S\.?r\.?l\.?|S\.?p\.?A\.?|S\.?L\.?U?|Inc\.?|LLC|Corp(?:oration)?|"
                     r"Pty|Pte|AB|A/S|ApS|Oy|AS|Sp\. z o\.o\.|K\.?K\.?|Kft)\b")
_NAME = rf"((?:[A-Z0-9][\w&'’.-]*\s+){{0,6}}?{_ENTITY})"
_ACQ = [
    re.compile(rf"\bacquired\s+(?:the\s+)?(?:entire|whole|100%|all)\s+(?:of\s+the\s+)?(?:issued\s+)?(?:share\s+capital|shares)\s+(?:in|of)\s+{_NAME}", re.I),
    re.compile(rf"\b(?:completed|completion of)\s+(?:the\s+)?acquisition\s+of\s+{_NAME}", re.I),
    re.compile(rf"\bacquisition\s+of\s+{_NAME}\s*(?:,|\(|on\b|in\b|for\b|during\b|was\b|which\b)", re.I),
    re.compile(rf"\bacquired\s+{_NAME}\s*(?:,|\(|on\b|in\b|for\b|a\s|an\s|which\b)", re.I),
]
_GENERIC = re.compile(r"\b(?:purchase|acquisition)s?\s+of\s+(?:a\s+)?subsidiar(?:y|ies)\b|\bbusiness\s+combinations?\s+(?:during|in)\s+the\s+(?:year|period)\b", re.I)
_NOT_DEAL = re.compile(r"\b(?:policy|policies|accounting for|are accounted|is accounted|measured at|recognised at|"
                       r"intangible assets acquired|on the acquisition of a subsidiary,? (?:the|any)|fair value of the identifiable)\b", re.I)


def _sentences(text: str):
    for s in re.split(r"(?<=[.!?])\s+(?=[A-Z(])", re.sub(r"\s+", " ", text or "")):
        if 30 <= len(s) <= 600:
            yield s.strip()


def acquisitions(text: str, max_items: int = 4) -> list[dict]:
    """Companies the filing says were bought in the year (named), or a plain "bought a subsidiary" line; not policy text."""
    out, seen = [], set()
    generic = ""
    for s in _sentences(text):
        if _NOT_DEAL.search(s) and not re.search(r"\bon \d{1,2} \w+ 20\d\d\b|\bduring the (?:year|period)\b", s, re.I):
            continue
        for rx in _ACQ:
            for m in rx.finditer(s):
                name = re.sub(r"^(?:the|its|a|an)\s+", "", m.group(1).strip(" ,.("), flags=re.I)
                key = name.upper()
                if len(name) < 5 or key in seen or re.match(r"(?:company|group|business|subsidiary|shares)\b", name, re.I):
                    continue
                seen.add(key)
                out.append({"name": name, "abroad": bool(FOREIGN.search(name)), "sentence": s[:400]})
        if not generic and _GENERIC.search(s) and not _NOT_DEAL.search(s):
            generic = s[:400]
        if len(out) >= max_items:
            break
    if not out and generic:
        out.append({"name": "", "abroad": False, "sentence": generic})
    return out


_FIN_TITLE = r"(?:Chief Financial Officer|CFO|Finance Director|Group Finance Director|Director of Finance|Financial Director)"
_APPOINTED = r"\(?\s*appointed\s+(?:on\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+\s+20\d\d|\d{1,2}/\d{1,2}/20\d\d)\s*\)?"
_FIN_APPT = [re.compile(rf"{_FIN_TITLE}[^.;\n]{{0,60}}?{_APPOINTED}", re.I), re.compile(rf"{_APPOINTED}[^.;\n]{{0,40}}?{_FIN_TITLE}", re.I)]


def finance_appointments(text: str) -> list[dict]:
    """A finance director / CFO the accounts say was appointed (with the date), from the directors' list."""
    out, seen = [], set()
    flat = re.sub(r"[ \t]+", " ", text or "")
    for rx in _FIN_APPT:
        for m in rx.finditer(flat):
            when = m.group(1)
            if when in seen:
                continue
            seen.add(when)
            before = flat[max(0, m.start() - 80):m.start()]
            cut = max(before.rfind(";"), before.rfind("."), before.rfind("\n"))
            start = m.start() - len(before) + (cut + 1 if cut >= 0 else 0)
            out.append({"when": when, "sentence": flat[start:m.end()].strip(" ;,")[:300]})
    return out[:2]


def columns(text: str) -> dict:
    """The filings row's deal columns: what it bought (named, abroad flagged) and a finance director appointed."""
    acq = acquisitions(text)
    fd = finance_appointments(text)
    named = [a["name"] + (" (abroad)" if a["abroad"] else "") for a in acq if a["name"]]
    return {
        "acquisitions": "; ".join(named) if named else ("Bought a subsidiary in the year" if acq else ""),
        "acquisitions_evidence": " … ".join(a["sentence"] for a in acq[:2]),
        "acquired_abroad": "yes" if any(a["abroad"] for a in acq) else "",
        "new_fd_in_accounts": f"Finance director appointed {fd[0]['when']}" if fd else "",
        "new_fd_in_accounts_evidence": fd[0]["sentence"] if fd else "",
    }
