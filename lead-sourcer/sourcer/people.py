"""
sourcer/people.py — who runs the money: the best finance contact for a
company, from the sources that name one, strongest first:

  1. a director's filed occupation on Companies House (rare);
  2. a person listed with a finance title in the filed accounts
     ("A Jones (Finance Director)", "Chief Financial Officer: Jane Smith");
  3. the same on the company's own website (team / leadership pages);
  4. the company secretary — in a mid-market private company, very often
     the finance director;
  5. the director who signed the accounts — often, not always, the FD.

Names only, from public filings and the company's own pages. Each pick
says where it came from.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Optional

from sourcer import roles

_FINANCE_TITLE_RE = re.compile(
    r"\b(?:Group\s+|Interim\s+|Deputy\s+|UK\s+)?(?:Chief\s+Financial\s+Officer|Chief\s+Finance\s+Officer|CFO|"
    r"Finance\s+(?:(?:&|and)\s+(?:Administration|Operations|Commercial|IT|Business)\s+)?Director|Financial\s+Director|Director\s+of\s+Finance|Financial\s+Controller|Finance\s+Controller|"
    r"Head\s+of\s+Finance|Finance\s+Manager|Treasurer|Head\s+of\s+Treasury|Treasury\s+Manager|"
    r"V\.?P\.?,?\s+(?:of\s+)?Finance|Vice\s+President,?\s+(?:of\s+)?Finance|Director\s*[,–—-]\s*Finance|Chief\s+Accountant)\b",
    re.I)
_TOKEN = r"[A-ZÀ-ÖØ-Þ](?:[^\W\d_]|['’-])*\.?"   # letters with accents too ("Bauló")
_NAME_AT_END = re.compile(rf"((?:{_TOKEN}\s+){{1,4}}{_TOKEN})$")
_NAME_AT_START = re.compile(rf"^((?:{_TOKEN}\s+){{1,4}}{_TOKEN})")
_HONORIFICS = {"MR", "MRS", "MS", "MISS", "DR", "SIR", "DAME", "PROF"}
_NOT_NAME = {
    "DIRECTOR", "DIRECTORS", "MANAGING", "GROUP", "COMPANY", "LIMITED", "LTD", "PLC", "LLP", "THE", "BOARD", "REPORT",
    "CHIEF", "EXECUTIVE", "OFFICER", "FINANCE", "FINANCIAL", "HEAD", "SECRETARY", "CHAIRMAN", "CHAIR", "NON",
    "OUR", "TEAM", "MEET", "AND", "OF", "FOR", "WITH", "BY", "ON", "IN", "AT", "TO", "AN", "INTERIM",
    "DEPUTY", "CONTROLLER", "MANAGER", "TREASURER", "TREASURY", "OPERATIONS", "SALES", "COMMERCIAL", "SIGNED",
    "APPROVED", "STRATEGIC", "ACCOUNTS", "STATEMENTS", "CONTACT", "ABOUT", "US", "UK", "CFO", "CEO", "MD", "FD",
    "COO", "INDEPENDENT", "AUDITORS", "BANKERS", "SOLICITORS", "REGISTERED", "OFFICE", "NUMBER", "LEADERSHIP",
    "PEOPLE", "SENIOR", "MANAGEMENT", "HOME", "NEWS", "CAREERS", "VIEW", "PROFILE", "READ", "MORE", "BIO",
    # organisation, address and headline words that sit next to a title but aren't a person
    "HOUSE", "FOOD", "FOODS", "GLOBAL", "HOLDINGS", "INTERNATIONAL", "TRADING", "SERVICES", "SOLUTIONS", "BRANDS",
    "PRODUCTS", "INDUSTRIES", "MANUFACTURE", "MANUFACTURING", "MEDIA", "BRIEFINGS", "CONDUCTS", "MAGAZINE",
    "JOURNAL", "TIMES", "GAZETTE", "DAILY", "WEEKLY", "INSIDER", "APPOINTS", "NAMES", "HIRES", "WELCOMES",
    "ANNOUNCES", "FORMER", "EX", "ROAD", "STREET", "ESTATE", "BUILDING", "CENTRE", "INDUSTRIAL", "UNIT", "FLOOR",
}
_CONNECTORS_AT_END = re.compile(
    r"(?:[\s,]+(?:as|is|the|new|its|our|their|appointed|named|becomes|joins|joined|has\s+been|was|will\s+be|"
    r"promoted\s+to|to))+\s*$", re.I)
# Accountancy qualifications written after a name ("Jane Smith FCA", "J Doe BSc, ACMA").
_QUALIFICATION_RE = re.compile(r"\b(ACA|FCA|ACCA|FCCA|ACMA|FCMA|CGMA|CIMA|CPA|CTA|CA)\b")
_DEGREES = re.compile(r"(?:[\s,]+(?:BSc|BA|MA|MSc|MBA|BCom|MEng|BEng|LLB|PhD|Hons|\(Hons\)|ACA|FCA|ACCA|FCCA|ACMA|"
                      r"FCMA|CGMA|CIMA|CPA|CTA|CA))+\s*$")
# Concepts some filings use to tag the director who signed the accounts.
SIGNATORY_CONCEPTS = {"DirectorSigningFinancialStatements", "NameDirectorSigningFinancialStatements"}
_SIGNED_RE = re.compile(r"\bsigned\s+on\s+(?:its|their|behalf\s+of\s+the\s+(?:board|directors|company))\s*"
                        r"(?:behalf\s+)?by\s*:?\s*", re.I)


def _clean_name(tokens: list[str]) -> str:
    """The longest run of name-like tokens at the end of `tokens` (2-4 words), or ""."""
    run: list[str] = []
    for tok in reversed(tokens):
        word = tok.strip(".").upper()
        if word in _NOT_NAME or word in _HONORIFICS or word.startswith("EX-"):
            break
        run.insert(0, tok)
    if not 2 <= len(run) <= 4 or len(run[-1].strip(".")) < 2:
        return ""
    name = " ".join(run)
    return name.title() if name.isupper() else name


def _name_before(text: str) -> str:
    """Name ending right before a title: on the same line, or alone on the line above ("Mark Lee\nFinance Director")."""
    lines = text.split("\n")
    # "Acme appoints Jane Smith as Finance Director", "Jane Smith, our new CFO"
    same = _CONNECTORS_AT_END.sub("", lines[-1].rstrip(" ,(–—-:\t")).rstrip(" ,(–—-:\t")
    if same.strip():
        m = _NAME_AT_END.search(same)
        return _clean_name(m.group(1).split()) if m else ""
    above = lines[-2].strip(" ,(–—-:\t") if len(lines) > 1 else ""
    m = _NAME_AT_END.search(above)
    return _clean_name(above.split()) if m and m.group(1) == above else ""


def _name_after(text: str) -> str:
    """Name right after a title, on the same line or the next ("Head of Finance\nKaren Patel")."""
    text = text.lstrip(" ,)–—-:\t")
    text = text.lstrip("\n").split("\n", 1)[0] if text.startswith("\n") else text.split("\n", 1)[0]
    m = _NAME_AT_START.match(text.lstrip(" ,)–—-:\t"))
    if not m:
        return ""
    tokens = m.group(1).split()
    while tokens and tokens[0].strip(".").upper() in _HONORIFICS:
        tokens = tokens[1:]
    run = []
    for tok in tokens:
        if tok.strip(".").upper() in _NOT_NAME or tok.upper().startswith("EX-") or tok in run:  # a repeated word starts the next sentence ("Karen Patel Karen joined")
            break
        run.append(tok)
    return _clean_name(run)


def _normalise(text: str) -> str:
    """Spaces collapsed; line breaks kept (one per block), as they separate people on a page."""
    text = re.sub(r"[ \t\r\f\v\u00a0]+", " ", text)
    return re.sub(r"\s*\n\s*", "\n", text).strip()


def _words(text: str) -> set[str]:
    return {w for w in re.sub(r"[^A-Z0-9 ]+", " ", text.upper()).split() if w}


def finance_people(text: str, not_names: str = "") -> list[dict]:
    """
    [{"name", "title"}] for people named next to a finance title in free text
    (accounts, web pages, headlines). `not_names`: the company's or the news
    outlet's name — a "name" made only of those words ("Daybreak Foods CFO")
    is the organisation, not a person.
    """
    text = _normalise(text)
    org = _words(not_names)
    found: dict[str, dict] = {}
    for m in _FINANCE_TITLE_RE.finditer(text):
        title = " ".join(m.group(0).split())
        title = title.title() if (title.isupper() and title != "CFO") or title.islower() else title
        name = _name_before(text[max(0, m.start() - 60):m.start()]) or _name_after(text[m.end():m.end() + 60])
        if name and org and _words(name) <= org:
            continue
        if name and name.upper() not in found:
            found[name.upper()] = {"name": name, "title": title}
    # most senior first (a page often lists the finance manager before the FD); page order among equals
    return sorted(found.values(), key=lambda p: finance_rank(p["title"]))


def qualified_people(text: str) -> list[dict]:
    """[{"name", "letters"}] for people written with accountancy letters after their name."""
    text = _normalise(text)
    found: dict[str, dict] = {}
    for m in _QUALIFICATION_RE.finditer(text):
        before = text[max(0, m.start() - 60):m.start()].split("\n")[-1].rstrip(" ,(–—-:\t")
        before = _DEGREES.sub("", before).rstrip(" ,(–—-:\t")
        match = _NAME_AT_END.search(before)
        name = _clean_name(match.group(1).split()) if match else ""
        if name and name.upper() not in found:
            found[name.upper()] = {"name": name, "letters": m.group(1)}
    return list(found.values())


def signatory_from_text(text: str) -> str:
    """The name after "signed on its behalf by", or ""."""
    text = _normalise(text)
    for m in _SIGNED_RE.finditer(text):
        name = _name_after(text[m.end():m.end() + 60])
        if name:
            return name
    return ""


def _key(name: str) -> tuple[str, str]:
    """(first initial, surname) — "Mrs Jane A. Smith", "J Smith" and "Jane Smith" agree."""
    words = [w.strip(".,").upper() for w in name.split() if w.strip(".,").upper() not in _HONORIFICS]
    return (words[0][:1], words[-1]) if len(words) >= 2 else ("", words[-1] if words else "")


def same_person(a: str, b: str) -> bool:
    ka, kb = _key(a), _key(b)
    return bool(ka[1]) and ka[1] == kb[1] and (not ka[0] or not kb[0] or ka[0] == kb[0])


VERIFIED, CONFIRMED, LIKELY, GUESS = "Verified", "Confirmed", "Likely", "Guess"


# Most senior first: who to call about FX. Those before "financial controller" run the finance function.
_FINANCE_RANK = ("chief financial", "chief finance", "cfo", "finance director", "financial director",
                 "director of finance", "director finance", "vp finance", "vp of finance", "vice president finance",
                 "vice president of finance", "head of finance", "treasurer", "head of treasury",
                 "financial controller", "finance controller", "chief accountant", "treasury manager", "finance manager")
FINANCE_DIRECTOR_LEVEL = _FINANCE_RANK.index("financial controller")


def finance_rank(title: str) -> int:
    """Position in _FINANCE_RANK (lower = more senior; len() when not a finance title)."""
    t = re.sub(r"[\s,.–—-]+", " ", (title or "").lower())          # "Director – Finance", "V.P., Finance"
    t = re.sub(r"finance (?:&|and) \w+ director", "finance director", t)
    t = re.sub(r"\bfd\b", "finance director", t).replace("v p ", "vp ")
    return next((i for i, s in enumerate(_FINANCE_RANK) if s in t), len(_FINANCE_RANK))


def is_finance_director(title: str) -> bool:
    """Runs the finance function (CFO, FD, head of finance), not a controller or manager under them."""
    return finance_rank(title) < FINANCE_DIRECTOR_LEVEL


def is_finance_title(title: str) -> bool:
    return bool(_FINANCE_TITLE_RE.search(title or ""))


def choose_finance_contact(officers: list[dict], accounts_people: list[dict], website_people: list[dict],
                           signatory: str = "", qualified: list[dict] = (), news_people: list[dict] = (),
                           registry_people: list[dict] = ()) -> Optional[dict]:
    """
    {"name", "role", "source", "confidence", "officer"} for the best finance
    contact, or None. `officer` is the matching Companies House officer, if
    any (so the lead director can be someone else).

    `registry_people` are dated gov.uk filings (gender pay gap, modern
    slavery) naming a person with a job title; only finance titles are
    picked here, after the website and before the news.

    Confidence (corroborate() can then raise it to Verified):
      Confirmed  a finance job title says so: filed occupation, accounts,
                 the company's website, a registry filing or a dated news
                 item (2 years or less);
      Likely     a qualified accountant on the board / as secretary, or the
                 secretary also signed the accounts, or older news;
      Guess      company secretary alone, or the director who signed the accounts.
    """
    def officer_for(name: str) -> Optional[dict]:
        return next((o for o in officers if same_person(o["name"], name)), None)

    def letters_for(name: str) -> str:
        return next((q["letters"] for q in qualified if same_person(q["name"], name)), "")

    directors = [o for o in officers if o["role"] != "Company Secretary"]
    fd = roles.pick_finance_director(directors)
    if fd and is_finance_director(fd["occupation"]):
        return {"name": fd["name"], "role": fd["occupation"], "source": "Companies House occupation",
                "confidence": CONFIRMED, "officer": fd}
    # The most senior finance title any source gives, not the first source with someone: a board director filed as
    # "Accountant" or "Finance Manager" doesn't stop us finding the FD the website or a filing names. Among equals the
    # source order below decides; a board director with a finance occupation counts as controller level and wins ties.
    registry_finance = [p for p in registry_people if is_finance_title(p.get("title", ""))]
    named = [(p, where) for found, where in ((accounts_people, "filed accounts"), (website_people, "company website"),
                                             (registry_finance, ""), (news_people, "news")) for p in found]
    best = min(named, key=lambda pw: finance_rank(pw[0]["title"]), default=None)
    titled = bool(fd) and is_finance_title(fd["occupation"])   # "Finance Manager", not just "Accountant"
    if titled and (best is None or min(finance_rank(fd["occupation"]), FINANCE_DIRECTOR_LEVEL) <= finance_rank(best[0]["title"])):
        return {"name": fd["name"], "role": fd["occupation"], "source": "Companies House occupation",
                "confidence": CONFIRMED, "officer": fd}
    if best:
        p, where = best
        where = where or p["source"]
        officer = officer_for(p["name"])
        also = " (also a director)" if officer and officer["role"] != "Company Secretary" else ""
        note = f" — {p['note']}" if p.get("note") else ""
        return {"name": officer["name"] if officer else p["name"], "role": p["title"],
                "source": f"{where}: listed as {p['title']}{also}{note}",
                "confidence": p.get("confidence", CONFIRMED), "officer": officer}
    if fd:
        # a director whose filed occupation is only "Accountant" / "Chartered Accountant": likely the finance lead,
        # but no finance title says so (CLAUDE.md: a qualified accountant on the board comes after the named titles)
        return {"name": fd["name"], "role": fd["occupation"],
                "source": f"Companies House occupation: {fd['occupation']} on the board — likely the finance lead",
                "confidence": LIKELY, "officer": fd}

    secretary = next((o for o in officers if o["role"] == "Company Secretary"), None)
    accountants = [o for o in officers if letters_for(o["name"])]
    if accountants:
        pick = secretary if secretary in accountants else accountants[0]
        director = next((d for d in directors if same_person(d["name"], pick["name"])), None)
        role = "Company Secretary" if pick is secretary else "Director"
        return {"name": pick["name"], "role": f"{role} ({letters_for(pick['name'])})",
                "source": f"qualified accountant ({letters_for(pick['name'])}) and {role.lower()} — likely the finance lead",
                "confidence": LIKELY, "officer": director}
    if secretary:
        director = next((d for d in directors if same_person(d["name"], secretary["name"])), None)
        signed = bool(signatory) and same_person(secretary["name"], signatory)
        return {"name": secretary["name"], "role": "Company Secretary",
                "source": "company secretary" + (" and director" if director else "")
                          + (", signed the accounts" if signed else "") + " — often the finance lead",
                "confidence": LIKELY if signed else GUESS, "officer": director}
    if signatory and len(directors) > 1:
        officer = next((d for d in directors if same_person(d["name"], signatory)), None)
        if officer and roles.classify_role(officer.get("occupation") or "") not in ((1, "Managing Director"), (1, "CEO")):
            return {"name": officer["name"], "role": "Director", "source": "signed the accounts — often the finance director",
                    "confidence": GUESS, "officer": officer}
    return None


def corroborate(contact: Optional[dict], officers: list[dict], accounts_people: list[dict] = (),
                website_people: list[dict] = (), signatory: str = "", news_people: list[dict] = (),
                registry_people: list[dict] = (), appointments: Optional[dict] = None,
                today: Optional[date] = None) -> dict:
    """
    How many independent sources name the picked finance contact, and what
    they say. Returns {"confidence", "evidence": [str], "sources": int}.

    Verified  a finance title from at least one source, the same person in at
              least two independent sources, and one of them current (an
              active Companies House appointment, the website, or a filing or
              news item from the last 18 months).
    Lowered to Guess when a registry gives them a non-finance title, or they
    hold many unrelated appointments (a professional company secretary).
    `appointments`: {"active": n, "related": k} for the picked officer.
    """
    if not contact:
        return {"confidence": "", "evidence": [], "sources": 0}
    today = today or date.today()
    recent = (today - timedelta(days=548)).isoformat()
    name = contact["name"]
    evidence, kinds, titles, current = [], set(), [contact.get("role", "")], False

    officer = next((o for o in officers if same_person(o["name"], name)), None)
    if officer:
        since = f" since {officer['appointed_on'][:4]}" if officer.get("appointed_on") else ""
        evidence.append(f"Companies House: {officer['role'].lower()}{since}")
        kinds.add("Companies House")
        titles.append(officer.get("occupation", ""))
        current = True
    in_accounts = next((p for p in accounts_people if same_person(p["name"], name)), None)
    if in_accounts or (signatory and same_person(signatory, name)):
        evidence.append(f"accounts: {in_accounts['title']}" if in_accounts else "signed the accounts")
        kinds.add("accounts")
        titles.append(in_accounts["title"] if in_accounts else "")
    on_site = next((p for p in website_people if same_person(p["name"], name)), None)
    if on_site:
        evidence.append(f"company website: {on_site['title']}")
        kinds.add("company website")
        titles.append(on_site["title"])
        current = True
    in_news = next((p for p in news_people if same_person(p["name"], name)), None)
    if in_news:
        evidence.append(f"news: {in_news['title']} ({in_news['date'][:7]})")
        kinds.add("news")
        titles.append(in_news["title"])
        current = current or in_news["date"] >= recent
    warning = ""
    for p in registry_people:
        if not same_person(p["name"], name) or p["source"] in kinds:
            continue
        when = f" ({p['date'][:7]})" if p.get("date") else ""
        evidence.append(f"{p['source']}: {p['title'] or 'named'}{when}")
        kinds.add(p["source"])
        titles.append(p["title"])
        current = current or p.get("date", "") >= recent
        if p["title"] and not is_finance_title(p["title"]) and not warning:
            warning = f"{p['source']} lists them as {p['title']}"

    if appointments and officer:
        active, related = appointments.get("active", 0), appointments.get("related", 0)
        if active >= 10 and related < 0.3 * active:
            warning = warning or f"officer of {active} companies — looks like a professional company secretary"
        elif related >= 2:
            evidence.append(f"officer of {related} group companies")

    confidence = contact["confidence"]
    if warning:
        evidence.append("but " + warning)
        confidence = GUESS
    elif any(is_finance_title(t) for t in titles) and len(kinds) >= 2 and current:
        confidence = VERIFIED
    return {"confidence": confidence, "evidence": evidence, "sources": len(kinds)}
