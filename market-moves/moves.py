#!/usr/bin/env python3
"""
market-moves/moves.py — the day-to-day market moves for the FX desk: how the
pound has moved against each currency the account list deals in, from the
European Central Bank's official daily reference rates (free, no key, no AI).

    python3 moves.py --output market.json

For each currency: GBP rate (units per £1), change over 1 day / 1 week /
1 month / 3 months, whether the move is material (MOVE_RULES), and what it
does to £ per 1 million units ("every €1m of purchases now costs £18,400
more than a month ago"), plus 90 days of history for a chart. GBP crosses are
derived from the ECB's EUR rates (GBP/X = EUR/X ÷ EUR/GBP), which is how the
ECB publishes them. The dashboard's /moves page joins this with the account
list (in the browser, behind the Accounts password) — nothing here touches
the company finder.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from typing import Optional

ECB_90D = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml"
USER_AGENT = "fx-market-moves/1.0 (+https://github.com/zacld/fx)"

# What counts as a move worth a call: |change| at least this many percent over the window.
MOVE_RULES = {"1m": 1.5, "3m": 3.0}
WINDOWS = {"1d": 1, "1w": 7, "1m": 30, "3m": 90}      # calendar days back to compare against
CURRENCIES = ["EUR", "USD", "CNY", "JPY", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "CAD", "AUD", "NZD",
              "HKD", "SGD", "INR", "ZAR", "TRY", "KRW", "THB"]
NAMES = {"EUR": "euro", "USD": "US dollar", "CNY": "Chinese renminbi", "JPY": "Japanese yen", "CHF": "Swiss franc",
         "SEK": "Swedish krona", "NOK": "Norwegian krone", "DKK": "Danish krone", "PLN": "Polish zloty",
         "CZK": "Czech koruna", "HUF": "Hungarian forint", "CAD": "Canadian dollar", "AUD": "Australian dollar",
         "NZD": "New Zealand dollar", "HKD": "Hong Kong dollar", "SGD": "Singapore dollar", "INR": "Indian rupee",
         "ZAR": "South African rand", "TRY": "Turkish lira", "KRW": "South Korean won", "THB": "Thai baht"}
SYMBOLS = {"EUR": "€", "USD": "$", "JPY": "¥", "CNY": "CN¥"}


def fetch(url: str = ECB_90D) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8")


def parse(xml_text: str) -> dict[str, dict[str, float]]:
    """{"2026-10-21": {"USD": 1.0857, "GBP": 0.8312, ...}} — EUR-based ECB rates by day."""
    days: dict[str, dict[str, float]] = {}
    for cube in ET.fromstring(xml_text).iter():
        when = cube.attrib.get("time")
        if when:
            days[when] = {c.attrib["currency"]: float(c.attrib["rate"]) for c in cube if "currency" in c.attrib}
    return days


def gbp_rates(days: dict[str, dict[str, float]]) -> dict[str, dict[str, float]]:
    """{"2026-10-21": {"EUR": 1.2031, "USD": 1.3062, ...}}: units of each currency per £1."""
    out = {}
    for when, rates in days.items():
        gbp = rates.get("GBP")
        if not gbp:
            continue
        out[when] = {"EUR": 1 / gbp, **{c: r / gbp for c, r in rates.items() if c != "GBP"}}
    return out


def _on_or_before(series: dict[str, float], target: str) -> Optional[tuple[str, float]]:
    earlier = [d for d in series if d <= target]
    return (max(earlier), series[max(earlier)]) if earlier else None


def per_million(rate_now: float, rate_then: float) -> float:
    """Change in £ for 1 million units of the currency: + = costs more in £ (the pound fell)."""
    return 1_000_000 / rate_now - 1_000_000 / rate_then


def moves(by_day: dict[str, dict[str, float]], currencies: list[str] = CURRENCIES) -> dict:
    """The market moves document (see module docstring)."""
    if not by_day:
        raise ValueError("no rates")
    as_of = max(by_day)
    as_of_day = date.fromisoformat(as_of)
    out = []
    for code in currencies:
        series = {d: r[code] for d, r in by_day.items() if code in r}
        if as_of not in series:
            continue
        now = series[as_of]
        changes, since, impact = {}, {}, {}
        for label, back in WINDOWS.items():
            target = (as_of_day - timedelta(days=back)).isoformat() if label != "1d" else \
                max((d for d in series if d < as_of), default="")
            found = _on_or_before(series, target) if target else None
            if not found and label == "3m" and series:      # the 90-day file can stop a day or two short
                found = (min(series), series[min(series)])
            if not found or found[0] >= as_of:
                continue
            changes[label] = round((now / found[1] - 1) * 100, 2)
            since[label] = found[0]
            impact[label] = round(per_million(now, found[1]))
        material = [w for w, threshold in MOVE_RULES.items() if abs(changes.get(w, 0)) >= threshold]
        out.append({
            "code": code, "name": NAMES.get(code, code), "symbol": SYMBOLS.get(code, ""), "rate": round(now, 4),
            "changes": changes, "since": since, "impact_per_million": impact, "material": material,
            "history": [[d, round(series[d], 4)] for d in sorted(series)],
        })
    out.sort(key=lambda c: -max((abs(c["changes"].get(w, 0)) for w in ("1m", "3m")), default=0))
    return {"made_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "as_of": as_of,
            "source": "European Central Bank euro reference rates (GBP crosses derived)", "rules": MOVE_RULES,
            "currencies": out}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", default="market.json")
    parser.add_argument("--xml", help="Read the ECB file from disk instead of downloading it")
    args = parser.parse_args()
    xml_text = open(args.xml, encoding="utf-8").read() if args.xml else fetch()
    doc = moves(gbp_rates(parse(xml_text)))
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    material = [c["code"] for c in doc["currencies"] if c["material"]]
    print(f"rates to {doc['as_of']}: {len(doc['currencies'])} currencies, material moves: {', '.join(material) or 'none'}")
    if not doc["currencies"]:
        sys.exit("no currencies read")


if __name__ == "__main__":
    main()
