"""
sourcer/control.py — where a company's finance decisions are made: in the UK, or by a parent abroad (Zac, 16 Nov
2026: "come up with indicators that can qualify or disqualify … look for clues in the accounts that decide whether the
decisions in terms of finances happen in the UK"). Read from the accounts already downloaded, no extra calls:

  * the accounts' own words — treasury or FX "managed centrally by the group / the parent", a group cash pool, the
    parent's letter of support, facilities provided by the parent, amounts owed to the parent (run from abroad) — or
    the company's own revolving credit facility / bank facilities, a UK-based treasury team (decided here);
  * the board — how many current directors live in the UK (`board_line`, from the Companies House officers already read).

Each clue keeps its sentence; the dashboard (`src/accounts/control.js`) weighs them with the owner, the lender and the
company's own hedging into a verdict and the questions to ask.
"""

from __future__ import annotations

import re

# (kind, side, pattern) — side "abroad": decisions sit with the group / parent; "uk": the UK company decides itself.
_CLUES = [
    ("group_treasury", "abroad", r"\btreasury\b[^.]{0,120}\b(?:managed|carried out|undertaken|performed|handled|operated|co-?ordinated)\b[^.]{0,40}"
                                 r"\b(?:centrally|at group level|by the (?:ultimate )?(?:parent|group)|by (?:its|the company'?s) (?:ultimate )?parent)"),
    ("fx_by_group", "abroad", r"\b(?:foreign (?:exchange|currency)|currency|exchange rate)\b[^.]{0,120}\b(?:managed|monitored|hedged|undertaken)\b[^.]{0,40}"
                              r"\b(?:centrally|at group level|by the (?:ultimate )?(?:parent|group)|on a group basis|by group treasury)"),
    ("fx_by_group", "abroad", r"\b(?:group|parent(?: company)?)'?s? (?:central )?treasury (?:function|department|team)\b"),
    ("cash_pool", "abroad", r"\b(?:group|notional|zero[- ]balancing)?\s*cash[- ]pool(?:ing)?\b"),
    ("parent_support", "abroad", r"\b(?:letter of (?:financial )?support|(?:continued|ongoing) (?:financial )?support)\b[^.]{0,80}\b(?:parent|ultimate|group|holding)\b"
                                 r"|\b(?:parent|ultimate parent|holding company)\b[^.]{0,60}\b(?:confirmed|agreed|undertaken)\b[^.]{0,40}\bsupport\b"),
    ("group_funding", "abroad", r"\b(?:funded|financed|facilities (?:are |is )?provided|funding (?:is )?provided)\b[^.]{0,40}\bby (?:the|its) (?:ultimate )?(?:parent|group|holding)"
                                r"|\bparty to (?:the|a) group(?:'s)? (?:banking|borrowing|facility|facilities|financing)"),
    ("owed_to_parent", "abroad", r"\bamounts? owed to (?:the |its )?(?:immediate |ultimate )?(?:parent(?: company| undertaking)?|holding company)\b"),
    ("own_rcf", "uk", r"\b(?:the company|the group|we)\b[^.]{0,60}\b(?:has|have|holds?|entered into|agreed|renewed|extended)\b[^.]{0,60}\brevolving credit facilit(?:y|ies)\b"
                      r"|\brevolving credit facilit(?:y|ies)\b[^.]{0,60}\bwith (?:HSBC|Barclays|Lloyds|NatWest|Santander|Bank of Scotland|Royal Bank|Investec|Clydesdale|Virgin Money|Close Brothers|Shawbrook|Allica)"),
    ("uk_treasury", "uk", r"\btreasury (?:function|team|department)\b[^.]{0,60}\b(?:in|based in|located in) the (?:UK|United Kingdom)\b"),
]
_COMPILED = [(k, side, re.compile(p, re.I)) for k, side, p in _CLUES]
_POLICY = re.compile(r"\b(?:accounting polic|is defined as|means\b|IFRS|FRS 10[0-9]|standard requires)", re.I)
MAX_CLUES = 4


def _sentence(text: str, start: int, end: int) -> str:
    a = max(text.rfind(". ", 0, start), text.rfind("\n\n", 0, start))
    b = text.find(". ", end)
    s = " ".join(text[(a + 2 if a >= 0 else max(0, start - 200)):(b + 1 if b >= 0 else end + 200)].split())
    return s[:220]


def text_clues(text: str) -> list[dict]:
    """[{kind, side, quote}] — at most one per kind, policy boilerplate skipped, abroad clues first."""
    found: dict[str, dict] = {}
    for kind, side, rx in _COMPILED:
        if kind in found:
            continue
        for m in rx.finditer(text or ""):
            quote = _sentence(text, m.start(), m.end())
            if _POLICY.search(quote):
                continue
            # a revolving facility that belongs to the parent is the group's, not the company's own
            if kind == "own_rcf" and re.search(r"\b(?:parent|group's|ultimate)\b", quote, re.I) and not re.search(r"\bthe group\b", quote, re.I):
                continue
            found[kind] = {"kind": kind, "side": side, "quote": quote}
            break
    return sorted(found.values(), key=lambda c: c["side"] != "abroad")[:MAX_CLUES]


def text_evidence(text: str) -> dict:
    """{control_clues, ultimate_parent…}: 'side|kind|quote' entries joined by ' ‖ ' for the list row, and the ultimate
    parent the accounts name (blank when none)."""
    return {"control_clues": " ‖ ".join(f"{c['side']}|{c['kind']}|{c['quote'].replace('‖', ' ')}" for c in text_clues(text)),
            **ultimate_parent(text)}


def _is_uk(place: str) -> bool:
    return bool(re.search(r"\b(?:united kingdom|england|scotland|wales|northern ireland|great britain|uk|british|english|scottish|welsh)\b",
                          place or "", re.I))


def board_line(directors: list[dict]) -> str:
    """'3 of 4 directors live in the UK' from the current directors' country of residence ('' when none known)."""
    known = [d for d in directors or [] if d.get("country_of_residence")]
    if not known:
        return ""
    uk = sum(1 for d in known if _is_uk(d["country_of_residence"]))
    return f"{uk} of {len(known)} directors live in the UK"


# "The ultimate parent undertaking is Acme Holding GmbH, a company incorporated in Germany." / "The company's ultimate
# controlling party is Acme Inc., registered in the United States." — who owns it at the top, and where (Zac, 16 Nov
# 2026: "figure out who owns them and whether they're based in the UK — our primary targets").
_ULTIMATE = re.compile(
    r"\b(ultimate (?:parent(?: undertaking| company| entity)?|holding company|controlling (?:party|entity|undertaking))|"
    r"immediate (?:parent(?: undertaking| company)?|holding company))\b[^.]{0,60}?\b(?:is|was|are|being)\s+"
    r"(?:the\s+)?([A-Z][\w&'’.\- ]{2,80}?)\s*(?:,|\(|\bwhich\b|\ba company\b|\bincorporated\b|\bregistered\b|\bdomiciled\b|\bbased\b)"
    r"[^.]{0,100}?\b(?:incorporated|registered|domiciled|based|established)\s+(?:and\s+\w+\s+)?in\s+(?:the\s+)?"
    r"([A-Z][A-Za-z.]+(?:\s+(?:of\s+)?[A-Z][A-Za-z.]+){0,3})", re.S)


def ultimate_parent(text: str) -> dict:
    """{ultimate_parent, ultimate_parent_country, ultimate_parent_evidence} — the ultimate parent the accounts name and
    where it's incorporated (an immediate parent only when no ultimate one is named); blank when none."""
    best = None
    for m in _ULTIMATE.finditer(text or ""):
        kind, name, country = m.group(1).lower(), m.group(2).strip(" ,"), m.group(3).strip(" .")
        if re.match(r"(?:the company|the group|this company)$", name, re.I):
            continue
        quote = _sentence(text, m.start(), m.end())
        if _POLICY.search(quote):
            continue
        found = {"ultimate_parent": name[:100], "ultimate_parent_country": country[:40], "ultimate_parent_evidence": quote}
        if kind.startswith("ultimate"):
            return found
        best = best or found
    return best or {"ultimate_parent": "", "ultimate_parent_country": "", "ultimate_parent_evidence": ""}
