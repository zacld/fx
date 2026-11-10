#!/usr/bin/env python3
"""
tools/ch_alerts.py — "ping me when…": Companies House's streaming feeds (officers, charges, owners) read since the
last run, turned into alerts for the companies on the Accounts and FX filings lists, plus new leads found in the
charges feed (a charge in favour of an FX provider or for trade finance proves FX activity — any company).

    CH_STREAM_KEY=… python3 tools/ch_alerts.py --tracked tracked.json --state stream.json --alerts alerts.json \
        --discoveries discoveries.json [--seconds 240] [--telegram]
    python3 tools/ch_alerts.py --alerts alerts.json --digest        # the 7am summary of the last 24 hours

Alerts:
  new_fd          a new director at a tracked company whom the news names as its finance director / CFO (hot)
  new_director    a new director at a tracked company (role unknown: Companies House no longer shows occupations)
  director_left   a director resigned — a finance director leaving opens the door to the next one
  new_charge      a new charge (security for a loan): refinancing, the moment banking relationships move
  charge_paid     a charge satisfied: a facility paid off or moved
  fx_charge       a charge in favour of an FX provider, or for trade finance / foreign exchange (hot; also a discovery
                  for a company not on the lists)
  new_owner       a new corporate owner (private-equity backed when the owner looks like a deal vehicle: hot)

Read-only on Companies House; free. Public repo: the log holds counts only. Telegram (TELEGRAM_BOT_TOKEN +
TELEGRAM_CHAT_ID secrets) gets the hot alerts as they're found and the 7am digest; nothing is sent otherwise.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from sourcer import companies_house, news, triggers  # noqa: E402

STREAM_BASE = "https://stream.companieshouse.gov.uk"
STREAMS = {"officers": "/officers", "charges": "/charges", "psc": "/persons-with-significant-control"}
RECENT_DAYS = 30            # an appointment, charge or change dated within this of the event counts as new
OWNER_RECENT_DAYS = 60
ALERTS_MAX = 600
NEWS_CHECKS_MAX = 25        # new directors checked against the news a run (Google News RSS: keep it gentle)
FD_NEWS_DAYS = 150          # a news appointment this recent confirms the new director as the finance director
HOT = {"new_fd", "fx_charge", "new_owner_pe"}

# Charges that prove FX: the holder is an FX provider, or the charge is for trade finance / foreign exchange.
FX_PROVIDERS = re.compile(r"\b(?:EBURY|CORPAY|CONVERA|CAMBRIDGE\s+(?:GLOBAL|MERCANTILE)|MONEYCORP|WESTERN\s+UNION|"
                          r"CURRENCIES\s+DIRECT|AFEX|ARGENTEX|ALPHA\s+(?:FX|GROUP\s+INTERNATIONAL)|GLOBAL\s+REACH|"
                          r"SMART\s+CURRENCY|CENTTRIP|IBANFIRST|KANTOX|CURRENCYCLOUD|BANKING\s+CIRCLE|"
                          r"FOREIGN\s+CURRENCY\s+EXCHANGE)\b", re.I)
FX_PURPOSE = re.compile(r"trade\s+finance|letters?\s+of\s+credit|documentary\s+credit|foreign\s+exchange|"
                        r"forward\s+(?:foreign\s+)?(?:exchange\s+)?contracts?|currency\s+(?:contracts?|hedg)|"
                        r"derivative|hedging|treasury\s+(?:dealing|products|transactions)", re.I)
_NUMBER = re.compile(r"/company/([A-Z0-9]{8})/")


def _day(value: str) -> Optional[date]:
    try:
        return date.fromisoformat((value or "")[:10])
    except ValueError:
        return None


def _within(value: str, today: date, days: int) -> bool:
    d = _day(value)
    return bool(d and today - timedelta(days=days) <= d <= today + timedelta(days=1))


def _person(name: str) -> str:
    """ "SMITH, John Andrew" -> "John Andrew Smith" (Companies House lists surname first)."""
    if "," in name:
        last, first = name.split(",", 1)
        return f"{first.strip().title()} {last.strip().title()}".strip()
    return name.strip().title()


def company_url(number: str) -> str:
    return f"https://find-and-update.company-information.service.gov.uk/company/{number}"


def classify(event: dict, tracked: dict[str, str], today: date) -> Optional[dict]:
    """One stream event as an alert, or None. tracked: {company number: name} of the Accounts + FX filings lists."""
    uri = event.get("resource_uri") or ""
    m = _NUMBER.search(uri + "/")
    if not m:
        return None
    number = m.group(1)
    kind = event.get("resource_kind") or ""
    data = event.get("data") or {}
    at = (event.get("event") or {}).get("published_at") or ""
    base = {"id": f"{kind}:{event.get('resource_id') or uri}", "at": at, "company_number": number,
            "company_name": tracked.get(number, ""), "tracked": number in tracked, "url": company_url(number)}

    if kind.startswith("company-charges"):
        holders = ", ".join(p.get("name", "") for p in data.get("persons_entitled") or [] if p.get("name"))
        words = " ".join([holders, (data.get("classification") or {}).get("description", ""),
                          (data.get("particulars") or {}).get("description", "")])
        provider = FX_PROVIDERS.search(holders)
        purpose = FX_PURPOSE.search(words)
        new = _within(data.get("delivered_on") or data.get("created_on") or "", today, RECENT_DAYS) \
            and data.get("status", "outstanding") == "outstanding"
        if (provider or purpose) and new:
            why = f"charge in favour of {holders}" if provider else f"charge for {purpose.group(0).lower()} ({holders})"
            return {**base, "kind": "fx_charge", "title": "Charge to an FX provider" if provider else "Trade finance / FX charge",
                    "detail": why, "url": company_url(number) + "/charges", "hot": True}
        if number not in tracked:
            return None
        if new:
            return {**base, "kind": "new_charge", "title": "New bank charge (refinancing)",
                    "detail": f"in favour of {holders}" if holders else "", "url": company_url(number) + "/charges",
                    "hot": False}
        if data.get("status") == "fully-satisfied" and _within(data.get("satisfied_on") or "", today, RECENT_DAYS):
            return {**base, "kind": "charge_paid", "title": "Charge paid off", "detail": f"was held by {holders}" if holders else "",
                    "url": company_url(number) + "/charges", "hot": False}
        return None

    if number not in tracked:
        return None

    if kind.startswith("company-officers"):
        role = (data.get("officer_role") or "").lower()
        if role not in ("director", "corporate-director", "secretary"):
            return None
        who = _person(data.get("name") or "")
        if data.get("resigned_on") and _within(data["resigned_on"], today, RECENT_DAYS):
            return {**base, "kind": "director_left", "title": "Director resigned" if role != "secretary" else "Company secretary left",
                    "detail": who, "person": who, "url": company_url(number) + "/officers", "hot": False}
        if not data.get("resigned_on") and _within(data.get("appointed_on") or "", today, RECENT_DAYS):
            occupation = data.get("occupation") or ""
            fd = bool(re.search(r"financ|\bCFO\b|treasur", occupation, re.I))
            return {**base, "kind": "new_fd" if fd else "new_director",
                    "title": "New finance director" if fd else ("New director" if role != "secretary" else "New company secretary"),
                    "detail": f"{who}{f' ({occupation})' if occupation else ''}", "person": who,
                    "url": company_url(number) + "/officers", "hot": fd}
        return None

    if kind.startswith("company-psc"):
        if "corporate" not in (data.get("kind") or "") or data.get("ceased_on"):
            return None
        if not _within(data.get("notified_on") or "", today, OWNER_RECENT_DAYS):
            return None
        owner = data.get("name") or ""
        country = ((data.get("identification") or {}).get("country_registered") or "").strip()
        pe = bool(triggers.investor_owner([{"kind": "corporate", "name": owner}]))
        return {**base, "kind": "new_owner_pe" if pe else "new_owner",
                "title": "New owner — looks private-equity backed" if pe else "New corporate owner",
                "detail": owner + (f" ({country})" if country else ""), "url": company_url(number) + "/persons-with-significant-control",
                "hot": pe}
    return None


def confirm_fd(alert: dict, fetcher=None, today: Optional[date] = None) -> dict:
    """A new director the news names as the company's finance director / CFO (recently) becomes a new_fd alert."""
    if alert["kind"] != "new_director" or not alert.get("company_name") or not alert.get("person"):
        return alert
    surname = alert["person"].split()[-1].upper()
    for p in news.appointments(alert["company_name"], fetcher=fetcher, today=today):
        if surname in p["name"].upper() and news.is_recent(p["date"], today, FD_NEWS_DAYS):
            return {**alert, "kind": "new_fd", "title": f"New {p['title'].lower()}", "hot": True,
                    "detail": f"{alert['person']} — {p['title']} ({p['note']})"}
    return alert


# --- Reading the streams -------------------------------------------------------------------------------------------

def read_stream(path: str, key: str, timepoint: Optional[int], seconds: float,
                opener=urllib.request.urlopen) -> tuple[list[dict], Optional[int], str]:
    """
    (events, last timepoint, why it stopped) — events since `timepoint` (from now when None or too old), read until
    caught up (an event published within two minutes of now) or `seconds` pass.
    """
    url = STREAM_BASE + path + (f"?timepoint={timepoint}" if timepoint else "")
    auth = base64.b64encode(f"{key}:".encode()).decode()
    request = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}"})
    events, last, why = [], timepoint, "time up"
    deadline = time.time() + seconds
    try:
        response = opener(request, timeout=60)
    except urllib.error.HTTPError as e:
        if e.code == 416 and timepoint:   # the timepoint has aged out of the stream: start again from now
            return read_stream(path, key, None, seconds, opener)
        return [], timepoint, f"HTTP {e.code}"
    except OSError as e:
        return [], timepoint, f"network: {type(e).__name__}"
    with response:
        for raw in response:
            if time.time() > deadline:
                break
            line = raw.strip()
            if not line:
                continue   # heartbeat
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            events.append(ev)
            meta = ev.get("event") or {}
            last = meta.get("timepoint", last)
            try:
                published = datetime.fromisoformat((meta.get("published_at") or "").replace("Z", "+00:00"))
                if published.tzinfo is None:
                    published = published.replace(tzinfo=timezone.utc)
                if datetime.now(timezone.utc) - published < timedelta(minutes=2):
                    why = "caught up"
                    break
            except ValueError:
                pass
    return events, last, why


def company_name(number: str, api_key: str) -> str:
    try:
        profile = companies_house.get_company_profile(number, api_key) or {}
    except Exception:  # noqa: BLE001 — a name is a nicety
        return ""
    return profile.get("company_name", "")


# --- Telegram ------------------------------------------------------------------------------------------------------

def telegram(text: str) -> bool:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(), os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat:
        return False
    body = urllib.parse.urlencode({"chat_id": chat, "text": text[:4000], "disable_web_page_preview": "true"}).encode()
    try:
        with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", body, timeout=20) as r:
            return r.status == 200
    except OSError:
        return False


def alert_line(a: dict) -> str:
    who = a.get("company_name") or a["company_number"]
    return f"{a['title']}: {who}" + (f" — {a['detail']}" if a.get("detail") else "") + f"\n{a['url']}"


def digest(alerts: list[dict], now: datetime) -> str:
    since = (now - timedelta(hours=24)).isoformat()
    recent = [a for a in alerts if (a.get("at") or "") >= since[:19]]
    if not recent:
        return ""
    hot = [a for a in recent if a.get("hot")]
    rest = [a for a in recent if not a.get("hot")]
    lines = [f"FX alerts — last 24 hours: {len(hot)} hot, {len(rest)} other"]
    lines += ["", "HOT"] + [alert_line(a) for a in hot[:15]] if hot else []
    counts: dict[str, int] = {}
    for a in rest:
        counts[a["title"]] = counts.get(a["title"], 0) + 1
    if counts:
        lines += ["", "Also: " + ", ".join(f"{n} × {t.lower()}" for t, n in sorted(counts.items(), key=lambda x: -x[1]))]
    lines += ["", "All alerts: the Alerts tab on the Accounts page"]
    return "\n".join(lines)


# --- Main ----------------------------------------------------------------------------------------------------------

def _load(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _save(path: str, data) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


def merge_alerts(old: list[dict], new: Iterable[dict]) -> list[dict]:
    by_id = {a["id"]: a for a in old}
    for a in new:
        if a["id"] not in by_id or (a.get("hot") and not by_id[a["id"]].get("hot")):
            by_id[a["id"]] = {**by_id.get(a["id"], {}), **a}
    return sorted(by_id.values(), key=lambda a: a.get("at") or "", reverse=True)[:ALERTS_MAX]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tracked", default="tracked.json")
    parser.add_argument("--state", default="stream.json")
    parser.add_argument("--alerts", default="alerts.json")
    parser.add_argument("--discoveries", default="discoveries.json")
    parser.add_argument("--seconds", type=float, default=240, help="per stream")
    parser.add_argument("--telegram", action="store_true", help="send hot alerts to Telegram as they're found")
    parser.add_argument("--digest", action="store_true", help="send the last 24 hours' summary to Telegram and stop")
    args = parser.parse_args()

    store = _load(args.alerts, {}) or {}
    alerts = store.get("items") or []
    now = datetime.now(timezone.utc)
    if args.digest:
        text = digest(alerts, now)
        sent = telegram(text) if text else False
        print(f"digest: {len([a for a in alerts if (a.get('at') or '') >= (now - timedelta(hours=24)).isoformat()[:19]])} "
              f"alerts in the last 24 hours; {'sent to Telegram' if sent else 'not sent (no Telegram secrets, or nothing new)'}")
        return

    key = os.environ.get("CH_STREAM_KEY", "").strip()
    if not key:
        print("No CH_STREAM_KEY secret: Companies House's streaming feeds need their own key (developer hub → "
              "your application → create a 'Streaming API' key). Nothing read.")
        with open("alerts_partial.txt", "w") as f:
            f.write("no stream key")
        return
    tracked = _load(args.tracked, {}) or {}
    state = _load(args.state, {}) or {}
    today = now.date()
    found: list[dict] = []
    stats: dict[str, int] = {}
    for name, path in STREAMS.items():
        events, last, why = read_stream(path, key, state.get(name), args.seconds)
        state[name] = last
        stats[f"{name} events"] = len(events)
        print(f"  {name}: {len(events):,} events ({why})")
        for ev in events:
            a = classify(ev, tracked, today)
            if a:
                found.append(a)
    news_checked = 0
    for i, a in enumerate(found):
        if a["kind"] == "new_director" and news_checked < NEWS_CHECKS_MAX:
            found[i] = confirm_fd(a, today=today)
            news_checked += 1
    api_key = os.environ.get("COMPANIES_HOUSE_API_KEY", "").strip()
    discoveries = _load(args.discoveries, {}) or {}
    rows = {r["company_number"]: r for r in discoveries.get("rows") or []}
    for a in found:
        if a["kind"] == "fx_charge" and not a["tracked"]:
            a["company_name"] = a["company_name"] or (company_name(a["company_number"], api_key) if api_key else "")
            rows.setdefault(a["company_number"], {"company_number": a["company_number"], "company_name": a["company_name"],
                                                   "discovered": a["at"][:10], "discovered_by": a["detail"],
                                                   "fx_today": f"Uses an FX provider: {a['detail']}", "filed_fx_score": 60})
    old_ids = {a["id"] for a in alerts}
    alerts = merge_alerts(alerts, found)
    fresh = [a for a in found if a["id"] not in old_ids]
    sent = 0
    if args.telegram:
        for a in fresh:
            if a.get("hot") and (a["tracked"] or a["kind"] == "fx_charge") and sent < 20 and telegram("🔔 " + alert_line(a)):
                sent += 1
    _save(args.state, state)
    _save(args.alerts, {"made_at": now.isoformat(), "count": len(alerts), "items": alerts})
    _save(args.discoveries, {"made_at": now.isoformat(), "rows": sorted(rows.values(), key=lambda r: r.get("discovered", ""), reverse=True)[:500]})
    kinds: dict[str, int] = {}
    for a in fresh:
        kinds[a["kind"]] = kinds.get(a["kind"], 0) + 1
    print(f"New alerts: {len(fresh)} ({', '.join(f'{k} {n}' for k, n in sorted(kinds.items())) or 'none'}); "
          f"news checks {news_checked}; Telegram sent {sent}; discoveries on file {len(rows)}; tracked companies {len(tracked):,}")


if __name__ == "__main__":
    main()
