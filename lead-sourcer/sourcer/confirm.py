"""
sourcer/confirm.py — the confirmation step, run on a finished company list:
for each checked company, a Google search for its finance team
(sourcer/profiles.py: LinkedIn profile results, board pages, news, org
charts), then the finance contact is re-graded:

  - the search names our pick with a finance title  -> Verified
    (the pick's own source plus the search: two independent sources);
  - the search shows our pick in a former or non-finance role (e.g. MD) -> Guess;
  - the search names a different finance person:
      our pick was a Guess (or nobody) -> a finance director over a
                                          controller, then the one most sites
                                          name, then the most senior, replaces it:
                                          Verified when 2+ separate websites
                                          name them, else Confirmed; the old
                                          guess is kept in the evidence;
      our pick was Confirmed/Likely    -> kept, the other name noted;
  - nobody found -> noted (if they're not findable, Cognism and similar
    databases likely won't have them either).

Adds `search_check` and `finance_contact_linkedin` (the public profile link,
when the person has one) and appends to `finance_contact_evidence`.
"""

from __future__ import annotations

from collections import Counter
from typing import Optional

from sourcer import news, people, profiles

NOT_CHECKED = "not checked"
NEW_FIELDS = ["search_check", "finance_contact_linkedin"]


def fields_with_confirmation(fields: list[str]) -> list[str]:
    """`fields` plus the confirmation columns, right after the finance contact's."""
    out = [f for f in fields if f not in NEW_FIELDS]
    anchor = next((f for f in ("finance_contact_evidence", "finance_contact_confidence") if f in out), None)
    at = out.index(anchor) + 1 if anchor else len(out)
    return out[:at] + NEW_FIELDS + out[at:]


def _evidence(row: dict, *items: str) -> str:
    return "; ".join(x for x in [row.get("finance_contact_evidence", ""), *items] if x)


def _named_by(p: dict) -> str:
    under = f" under its trading name {p['trading_as']}" if p.get("trading_as") else ""
    return f"Google search ({', '.join(p['sites'])}){under}: {p['title'] or 'named'}"


def confirm_row(row: dict, found: list[dict]) -> tuple[dict, str]:
    """(the row re-graded against who the search found at its company, outcome label — no names)."""
    row = {**row, "search_check": "", "finance_contact_linkedin": ""}
    pick, confidence = row.get("finance_contact", ""), row.get("finance_contact_confidence", "")
    # a finance director over a controller; among equals, the one most sites name, then the most senior
    finance = sorted((p for p in found if p["current"] and people.is_finance_title(p["title"])),
                     key=lambda p: (not people.is_finance_director(p["title"]), -len(p["sites"]),
                                    people.finance_rank(p["title"])))
    mine = next((p for p in found if pick and people.same_person(p["name"], pick)), None)
    if mine and mine["title"]:
        row["finance_contact_linkedin"] = mine["url"]
        if not mine["current"]:
            row.update(search_check=f"former role ({mine['title']})", finance_contact_confidence=people.GUESS,
                       finance_contact_evidence=_evidence(row, _named_by(mine), "but shown in a former role"))
            return row, "pick has left (former role)"
        if not people.is_finance_title(mine["title"]):
            row.update(search_check=f"search shows them as {mine['title']}", finance_contact_confidence=people.GUESS,
                       finance_contact_evidence=_evidence(row, _named_by(mine), f"but shown as {mine['title']}"))
            if finance and confidence in (people.GUESS, "", people.LIKELY):
                return _replace(row, finance[0], pick), "replaced a wrong pick"
            return row, "pick is not finance (other title)"
        row.update(search_check="agrees", finance_contact_evidence=_evidence(row, _named_by(mine)),
                   finance_contact_confidence=people.VERIFIED)
        return row, "agrees"
    if finance and (not pick or confidence in (people.GUESS, "")):
        return _replace(row, finance[0], pick), "replaced the guess" if pick else "found where we had nobody"
    if finance:
        row["search_check"] = "search also names " + ", ".join(f"{p['name']} ({p['title']})" for p in finance[:2])
        return row, "kept our pick, search names another"
    row["search_check"] = "no finance person found"
    return row, "nobody found"


def _replace(row: dict, p: dict, pick: str) -> dict:
    google, linkedin = news.verify_links(row["company_name"], p["name"])
    earlier = f"earlier pick: {pick} ({row.get('finance_contact_role', '')})" if pick else ""
    row.update(finance_contact=p["name"], finance_contact_role=p["title"],
               finance_contact_source=f"Google search: listed as {p['title']}",
               finance_contact_confidence=people.VERIFIED if len(p["sites"]) >= 2 else people.CONFIRMED,
               finance_contact_linkedin=p["url"],
               finance_contact_evidence="; ".join(x for x in (_named_by(p), earlier) if x),
               verify_finance_contact_url=google, linkedin_search_url=linkedin,
               search_check="found by search" + (f" under trading name {p['trading_as']}" if p.get("trading_as") else "") +
               (" (replaces the earlier pick)" if pick else "") +
               ("" if people.is_finance_director(p["title"]) else "; no finance director named"))
    return row


def confirm_rows(rows: list[dict], fetcher: Optional[profiles.Fetcher] = None, pause: Optional[float] = None,
                 key: Optional[str] = None, max_searches: Optional[int] = None) -> tuple[list[dict], Counter]:
    """
    Every checked row that isn't already Verified or qualified Out, in list order (best first),
    searched and re-graded until the search budget runs out; the others
    unchanged. Returns (rows, counts of outcomes — no names).
    """
    wanted = [r for r in rows if r.get("untapped_reasons") != NOT_CHECKED
              and r.get("finance_contact_confidence") != people.VERIFIED
              and r.get("qualified") != "Out"]   # qualified out: not worth a search
    found, status = profiles.finance_team_many([(r["company_number"], r["company_name"],
                                                 [n for n in (r.get("trading_as") or "").split("; ") if n])
                                                for r in wanted],
                                               fetcher=fetcher, pause=pause, key=key, max_searches=max_searches)
    stats: Counter = Counter({"to check": len(wanted), "checked": len(found), f"search {status}": 1})
    searched = {id(r) for r in wanted if r["company_number"] in found}
    out = []
    for row in rows:
        if id(row) in searched:
            before = row.get("finance_contact_confidence") or "none"
            row, outcome = confirm_row(row, found[row["company_number"]])
            stats[outcome] += 1
            stats[f"{before} -> {row['finance_contact_confidence'] or 'none'}"] += 1
        else:
            row = {**row, "search_check": row.get("search_check", ""),
                   "finance_contact_linkedin": row.get("finance_contact_linkedin", "")}
        out.append(row)
    return out, stats
