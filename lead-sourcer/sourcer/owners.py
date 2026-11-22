"""
sourcer/owners.py — who bought whom, from Companies House's free daily snapshot of people with significant control
(download.companieshouse.gov.uk/en_pscdata.html: one zip, every company's owners, JSON lines). Only corporate owners
matter here: a company taking a new corporate owner in the last WINDOW_DAYS was bought —

  pe_buyout     by a private-equity vehicle (Bidco / Topco / Midco / Holdco …, or a named UK PE house)
  eot           by an employee ownership trust
  overseas      by a company registered abroad (an overseas group's UK arm now — FX often runs through the parent)
  acquired      by a UK trading company: that buyer is buying subsidiaries (the lead is the buyer)

A new owner whose name shares the target's core name ("ACME HOLDINGS" over "ACME LTD") is a group reshuffle, not a
deal, and is skipped. Rule-based; no API calls.
"""

from __future__ import annotations

from collections import Counter

import io
import json
import os
import re
import urllib.request
import zipfile
from datetime import date, timedelta
from typing import Iterator, Optional

from sourcer import pe

PAGE = "https://download.companieshouse.gov.uk/en_pscdata.html"
DOWNLOADS = "https://download.companieshouse.gov.uk/"
USER_AGENT = "fx-lead-sourcer/1.0 (+https://github.com/zacld/fx)"
WINDOW_DAYS = 120
CORPORATE = '"corporate-entity-person-with-significant-control"'

PE_VEHICLE = re.compile(r"\b(?:BID ?CO|TOP ?CO|MID ?CO|HOLD ?CO|ACQUISITION ?CO|ACQUISITIONS? (?:LIMITED|LTD)|NEWCO|"
                        r"PURCHASER|BUYER|INVESTCO|FINCO|DEBTCO|PROJECT [A-Z]+)\b")
PE_HOUSES = pe.HOUSES   # the private-equity houses (sourcer/pe.py: one list for owners, charges and the accounts)
FUND = re.compile(r"\b(?:L\.?P\.?|LIMITED PARTNERSHIP|FUND [IVX\d]+|FUND)\b$")
EOT = re.compile(r"\bEMPLOYEE OWNERSHIP\b|\bEOT\b|\bEMPLOYEE (?:BENEFIT )?TRUST\b")
UK_PLACES = re.compile(r"companies house|register of companies|registrar of companies|england|wales|scotland|northern ireland|united kingdom", re.I)
UK_COUNTRIES = re.compile(r"^(?:england|wales|scotland|northern ireland|united kingdom|uk|great britain|england (?:and|&) wales)$", re.I)
CROWN = re.compile(r"^(?:jersey|guernsey|isle of man)$", re.I)   # UK owners' holding companies, as hooks.run_from_abroad
_STOP = {"LIMITED", "LTD", "PLC", "LLP", "GROUP", "HOLDINGS", "HOLDING", "UK", "THE", "AND", "&", "CO", "COMPANY",
         "INTERNATIONAL", "SERVICES", "TOPCO", "BIDCO", "MIDCO", "HOLDCO", "INVESTMENTS", "TRADING", "OF", "GLOBAL"}


def core_words(name: str) -> set[str]:
    return {w for w in re.findall(r"[A-Z0-9]+", (name or "").upper()) if w not in _STOP and len(w) > 2}


def same_group(owner: str, target: str) -> bool:
    return bool(core_words(owner) & core_words(target))


def ch_number(raw: str) -> str:
    """A Companies House number as the register writes it: 8 characters, zero-padded (SC/NI prefixes kept)."""
    n = re.sub(r"\s+", "", (raw or "").upper())
    m = re.match(r"^(SC|NI|OC|SO|NC|R0)?(\d{1,8})$", n)
    if not m:
        return ""
    prefix, digits = m.group(1) or "", m.group(2)
    return prefix + digits.zfill(8 - len(prefix))


def owner_kind(name: str, ident: dict) -> str:
    """pe / eot / overseas / uk — what kind of buyer a corporate owner is."""
    up = (name or "").upper()
    if EOT.search(up):
        return "eot"
    if PE_VEHICLE.search(up) or PE_HOUSES.search(up) or FUND.search(up) or pe.sponsor_kind(name):
        return "pe"
    country = (ident or {}).get("country_registered") or ""
    place = (ident or {}).get("place_registered") or ""
    if country and not UK_COUNTRIES.match(country.strip()) and not CROWN.match(country.strip()):
        return "overseas"
    if not country and place and not UK_PLACES.search(place):
        return "overseas"
    return "uk"


def snapshot_url(page_html: Optional[str] = None) -> str:
    html = page_html or _get(PAGE).decode("utf-8", "replace")
    whole = re.findall(r'href="([^"]*persons-with-significant-control-snapshot-[\d-]+\.zip)"', html)
    if not whole:
        raise RuntimeError("no PSC snapshot link on the page")
    u = whole[0]
    return u if u.startswith("http") else DOWNLOADS + u.lstrip("/")


def _get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=120) as r:
        return r.read()


def download(url: str, folder: str) -> str:
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, url.rsplit("/", 1)[-1])
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=300) as r, \
            open(path + ".part", "wb") as out:
        while chunk := r.read(1 << 22):
            out.write(chunk)
    os.replace(path + ".part", path)
    return path


def corporate_records(zip_path: str) -> Iterator[tuple[str, dict]]:
    """(company number, the owner record) for every corporate owner in the snapshot — the rest skipped unparsed."""
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            with zf.open(info) as f:
                for raw in io.TextIOWrapper(f, encoding="utf-8", errors="replace"):
                    if CORPORATE not in raw:
                        continue
                    try:
                        rec = json.loads(raw)
                    except ValueError:
                        continue
                    yield rec.get("company_number", ""), rec.get("data") or {}


def recent_changes(records, today: Optional[date] = None, window_days: int = WINDOW_DAYS) -> dict[str, dict]:
    """{target number: {"new": [owner records notified in the window, current], "gone": [ceased in the window]}}."""
    since = ((today or date.today()) - timedelta(days=window_days)).isoformat()
    out: dict[str, dict] = {}
    for number, d in records:
        if d.get("ceased_on"):
            if d["ceased_on"] >= since:
                out.setdefault(number, {"new": [], "gone": []})["gone"].append(d)
        elif (d.get("notified_on") or "") >= since:
            out.setdefault(number, {"new": [], "gone": []})["new"].append(d)
    return {n: c for n, c in out.items() if c["new"]}


def deals(changes: dict[str, dict], names: dict[str, str]) -> list[dict]:
    """The deals in the changes: [{kind, company_number (the lead), company_name, other_party, other_number,
    other_country, date, detail}] — a group reshuffle skipped, the buyer as the lead when a UK trading company bought."""
    out = []
    for target, c in changes.items():
        target_name = names.get(target, "")
        for d in c["new"]:
            owner = d.get("name") or ""
            ident = d.get("identification") or {}
            kind = owner_kind(owner, ident)
            # "ACME HOLDINGS" over "ACME LTD" is a reshuffle — but a PE vehicle is named after its target ("ACME BIDCO"),
            # so only one vehicle replacing another (the old owner gone in the window) rules that out
            if kind != "pe" and target_name and same_group(owner, target_name):
                continue
            if any(same_group(owner, g.get("name") or "") for g in c["gone"]):
                continue
            when = d.get("notified_on") or ""
            country = ident.get("country_registered") or ident.get("place_registered") or ""
            base = {"date": when, "other_party": owner, "other_country": country}
            if kind == "uk":
                buyer = ch_number(ident.get("registration_number") or "")
                if not buyer:
                    continue
                out.append({**base, "kind": "acquired", "company_number": buyer, "company_name": names.get(buyer, owner),
                            "other_party": target_name or target, "other_number": target,
                            "detail": f"Bought {target_name or target} (owner from {when})"})
            else:
                label = {"pe": "Bought by private equity", "eot": "Sold to an employee ownership trust",
                         "overseas": f"Bought by an overseas group ({country})"}[kind]
                out.append({**base, "kind": {"pe": "pe_buyout", "eot": "eot", "overseas": "overseas_buyer"}[kind],
                            "company_number": target, "company_name": target_name, "other_number": ch_number(ident.get("registration_number") or ""),
                            "detail": f"{label}: {owner} (from {when})"})
    return out


# --- Groups: every company's top UK parent (Zac, 14 Nov 2026: Cognism files people under the group, not the
# subsidiary we list, and one group showed up as several leads) ------------------------------------------------------

def _uk_owner(ident: dict) -> bool:
    where = " ".join(str(ident.get(k) or "") for k in ("country_registered", "place_registered", "legal_authority"))
    return bool(UK_PLACES.search(where)) and not CROWN.search((ident.get("country_registered") or "").strip())


def tee_parents(records, parents: dict, names: dict) -> Iterator[tuple[str, dict]]:
    """Pass the snapshot's records through unchanged while noting each company's current corporate owners:
    parents {number: [(owner number or "", owner name, UK?, country)]}, names {owner number: name}."""
    for number, d in records:
        if not d.get("ceased_on"):
            ident = d.get("identification") or {}
            uk = _uk_owner(ident)
            owner_no = ch_number(ident.get("registration_number") or "") if uk else ""
            parents.setdefault(number, []).append((owner_no, d.get("name") or "", uk,
                                                   ident.get("country_registered") or ident.get("place_registered") or ""))
            if owner_no:
                names.setdefault(owner_no, d.get("name") or "")
        yield number, d


def group_of(number: str, parents: dict, names: dict, max_hops: int = 8) -> dict:
    """{top, top_name, hops, abroad}: the company's top UK parent, walking up current UK corporate owners with a
    Companies House number (a joint venture's lowest-numbered UK owner; loops stopped), and the owner registered abroad
    above it, if any. hops 0 = the company is its own top."""
    cur, seen, hops = number, {number}, 0
    while hops < max_hops:
        ups = sorted(p[0] for p in parents.get(cur, []) if p[0] and p[2] and p[0] not in seen)
        if not ups:
            break
        cur = ups[0]
        seen.add(cur)
        hops += 1
    abroad = next((f"{p[1]} ({p[3]})" if p[3] else p[1] for p in parents.get(cur, []) if not p[2] and p[1]), "")
    return {"top": cur, "top_name": names.get(cur, "") if hops else "", "hops": hops, "abroad": abroad}


# What a holding company's group does (Zac's five good finds, 20 Nov 2026: three were holding companies — head office /
# holding company / financial-services sector codes — so the page called a freight group "Finance & insurance" and gave
# it no niche). Its trading subsidiaries' own sector codes, read down the ownership register, say what the group trades.
NON_TRADING_SIC = {"70100", "82990", "74909", "74990", "96090", "99999", "98000", "68209", "68100", "68320"}


def non_trading(code: str) -> bool:
    """A sector code that says nothing about what is traded: head office, holding company and other financial-services
    codes (64… / 66…), dormant, other business support, property letting."""
    code = str(code).zfill(5)
    return code in NON_TRADING_SIC or code[:2] in ("64", "66") or code.startswith("701")


def children_index(parents: dict) -> dict[str, list[str]]:
    """{UK owner's number: [companies it currently owns]} from the snapshot's parents (tee_parents)."""
    out: dict[str, list[str]] = {}
    for child, ups in parents.items():
        for p in ups:
            if p[0] and p[2] and p[0] != child:
                out.setdefault(p[0], []).append(child)
    return out


def descendants(number: str, children: dict, max_depth: int = 4, cap: int = 80) -> list[str]:
    """Every company under it (subsidiaries, theirs …), nearest first, at most `cap`; loops stopped."""
    out, seen, level = [], {number}, [number]
    for _ in range(max_depth):
        nxt = []
        for n in level:
            for c in sorted(children.get(n, [])):
                if c not in seen:
                    seen.add(c)
                    out.append(c)
                    nxt.append(c)
                    if len(out) >= cap:
                        return out
        level = nxt
        if not level:
            break
    return out


def group_activity(own_sics: list[str], subs: list[str], registry: dict, sized: set, niche_for=None) -> Optional[dict]:
    """{sic, subs, names, niche} for a company whose own sector codes say nothing about what it trades (non_trading) —
    its active trading subsidiaries' codes, a full / medium / group-accounts subsidiary counting three times a small
    one's; None when it trades itself or no subsidiary does. `niche_for(codes)` names the niche those codes fall in."""
    if own_sics and not all(non_trading(c) for c in own_sics):
        return None
    weights: Counter = Counter()
    trading = []
    for d in subs:
        rec = registry.get(d) or {}
        if (rec.get("status") or "").lower() != "active" or "DORMANT" in (rec.get("category") or "").upper():
            continue
        codes = [c for c in rec.get("sic_codes") or [] if not non_trading(c)]
        if not codes:
            continue
        w = 3 if rec.get("category") in sized else 1
        for c in codes:
            weights[c] += w
        trading.append((w, rec.get("name") or d, d))
    if not weights:
        return None
    top = [c for c, _ in weights.most_common(3)]
    trading.sort(key=lambda t: -t[0])
    return {"sic": top, "subs": len(trading), "names": [t[1] for t in trading[:3]], "numbers": [t[2] for t in trading[:3]],
            "niche": (niche_for(top) if niche_for else "") or ""}


def pe_owner(number: str, parents: dict, max_hops: int = 6) -> dict:
    """{name, hops} for the nearest current corporate owner anywhere up the chain (UK owners walked by number, owners
    registered abroad read by name) named like a PE house, fund or buyout vehicle (pe.sponsor_kind), else {}."""
    level, seen, hops = [number], {number}, 0
    while level and hops < max_hops:
        hops += 1
        nxt = []
        for cur in level:
            for owner_no, name, _uk, _country in parents.get(cur, []):
                if pe.sponsor_kind(name):
                    return {"name": name, "hops": hops}
                if owner_no and owner_no not in seen:
                    seen.add(owner_no)
                    nxt.append(owner_no)
        level = nxt
    return {}
