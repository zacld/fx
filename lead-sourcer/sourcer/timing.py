"""
sourcer/timing.py — when to call: the company's financial year-end (budgets
and hedging get planned in the months before it) and the months it shows up
in customs records (call ahead of the import season).

Informational only — it doesn't change any score.
"""

from __future__ import annotations

from datetime import date
from typing import Optional

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
PLANNING_MONTHS = 3  # budgets and hedging get set in the quarter before year-end


def _ranges(months: list[int]) -> str:
    """[3, 4, 5, 6, 9] -> "Mar–Jun, Sep" (calendar order, consecutive months joined)."""
    out, start, prev = [], None, None
    for m in sorted(months):
        if start is None:
            start = prev = m
        elif m == prev + 1:
            prev = m
        else:
            out.append((start, prev))
            start = prev = m
    if start is not None:
        out.append((start, prev))
    return ", ".join(MONTHS[a - 1] if a == b else f"{MONTHS[a - 1]}–{MONTHS[b - 1]}" for a, b in out)


def trade_season(periods: set[str], flow: str, today: date) -> str:
    """"imports Mar–Jun, Sep (next: Mar)", "imports every month", or "" — from YYYYMM periods."""
    months = sorted({int(p[4:6]) for p in periods if len(p) >= 6 and p[4:6].isdigit()})
    if not months:
        return ""
    if len(months) >= 10:
        return f"{flow} every month"
    upcoming = [m for m in months if m >= today.month] or months
    return f"{flow} {_ranges(months)} (next: {MONTHS[upcoming[0] - 1]})"


def next_year_end(period_end: str, today: date) -> Optional[date]:
    """The next financial year-end on or after today, from a past year-end "YYYY-MM-DD"."""
    try:
        last = date.fromisoformat(period_end[:10])
    except (TypeError, ValueError):
        return None
    day = min(last.day, 28) if last.month == 2 else last.day
    nxt = date(today.year, last.month, day)
    return nxt if nxt >= today else date(today.year + 1, last.month, day)


def when_to_call(trade: Optional[dict], period_end: str, today: Optional[date] = None) -> tuple[str, bool]:
    """(note, in the planning window now?) e.g. ("year-end 31 Dec: planning Sep–Nov | imports Mar–Jun (next: Mar)", True)."""
    today = today or date.today()
    parts, now = [], False
    ye = next_year_end(period_end, today)
    if ye:
        first = (ye.month - PLANNING_MONTHS - 1) % 12 + 1
        last = (ye.month - 2) % 12 + 1
        parts.append(f"year-end {ye.day} {MONTHS[ye.month - 1]}: planning {MONTHS[first - 1]}–{MONTHS[last - 1]}")
        start = date(ye.year if first < ye.month else ye.year - 1, first, 1)
        now = start <= today < date(ye.year, ye.month, 1)
    if trade:
        for flow, key in (("imports", "import_months"), ("exports", "export_months")):
            season = trade_season(trade[key], flow, today)
            if season:
                parts.append(season)
    return " | ".join(parts), now
