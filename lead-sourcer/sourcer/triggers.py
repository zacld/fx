"""
sourcer/triggers.py — recent events on the public register that open a
window to win a company's banking and FX: new owners, refinancing, new
directors.

Every trigger is a dated line of evidence, e.g.
  "new owner Acme Bidco Limited (2026-03) — looks private-equity backed".
Dates come from Companies House: PSC notified/ceased dates, charge
created/satisfied dates, director appointment dates.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

from sourcer import banks

# Acquisition-vehicle names: a private-equity buyout almost always leaves one of these as owner.
_DEAL_VEHICLE_WORDS = ("BIDCO", "TOPCO", "MIDCO", "ACQUISITIONCO", "ACQUICO", "NEWCO")
# Fund and investor names.
_INVESTOR_WORDS = ("PRIVATE EQUITY", "EQUITY PARTNERS", "CAPITAL PARTNERS", "GROWTH PARTNERS", " FUND ",
                   " LP", " L.P.", "VENTURES")

OWNER_WINDOW_DAYS = 548        # 18 months: a new owner is still reshaping the banking
CHARGE_WINDOW_DAYS = 365
DIRECTOR_WINDOW_DAYS = 365
RENEWAL_YEARS = (3, 5)         # typical term of a bank facility


def _ago(today: date, days: int) -> str:
    return (today - timedelta(days=days)).isoformat()


def investor_owner(owners: list[dict]) -> str:
    """Name of a current corporate owner that looks like a private-equity deal vehicle or fund, else ""."""
    for o in owners:
        if o["kind"] == "other" or (o["kind"] == "corporate" and not o.get("ceased_on")):
            name = f" {o['name'].upper()} "
            if any(w in name for w in _DEAL_VEHICLE_WORDS + _INVESTOR_WORDS):
                return o["name"]
    return ""


def find(owners: list[dict], charges: list[dict], directors: list[dict], today: Optional[date] = None) -> list[str]:
    """
    Trigger lines, newest kind of evidence first:
      - change of owner in the last 18 months (new PSC notified, or one ceased);
      - charge created, or paid off, in the last 12 months;
      - newest bank facility 3-5 years old (renewal due);
      - director appointed in the last 12 months.
    """
    today = today or date.today()
    lines = []
    pe = investor_owner(owners)
    owner_cutoff = _ago(today, OWNER_WINDOW_DAYS)
    # The PSC register started in April 2016: everyone notified then was already there.
    new = [o for o in owners if not o.get("ceased_on") and (o.get("notified_on") or "") >= max(owner_cutoff, "2016-07-01")]
    gone = [o for o in owners if o.get("ceased_on") not in ("", "unknown", None) and o["ceased_on"] >= owner_cutoff]
    for o in new:
        lines.append(f"new owner {o['name']} ({o['notified_on'][:7]})"
                     + (" — looks private-equity backed" if o["name"] == pe else ""))
    if gone and not new:
        o = max(gone, key=lambda o: o["ceased_on"])
        lines.append(f"owner {o['name']} stepped back ({o['ceased_on'][:7]})")

    charge_cutoff = _ago(today, CHARGE_WINDOW_DAYS)
    for c in sorted(charges, key=lambda c: c.get("created_on") or "", reverse=True):
        if (c.get("created_on") or "") >= charge_cutoff:
            lines.append(f"new charge to {c['name']} ({c['created_on'][:7]}) — new borrowing or a new bank")
            break
    paid = [c for c in charges if (c.get("satisfied_on") or "") >= charge_cutoff and c.get("status") != "outstanding"]
    if paid:
        c = max(paid, key=lambda c: c["satisfied_on"])
        lines.append(f"paid off charge to {c['name']} ({c['satisfied_on'][:7]}) — refinanced or left that lender")

    bank_charges = [c for c in charges if c.get("status") in ("outstanding", "part-satisfied") and c.get("created_on")
                    and (banks.classify(c["name"]) or ("", ""))[1] not in ("", "specialist lender")]
    if bank_charges:
        newest = max(bank_charges, key=lambda c: c["created_on"])
        lo, hi = RENEWAL_YEARS
        if _ago(today, 365 * hi + 1) <= newest["created_on"] <= _ago(today, 365 * lo):
            group = banks.classify(newest["name"])[0]
            lines.append(f"{group} facility from {newest['created_on'][:7]} — on a {lo}–{hi} year term, renewal is near")

    recent = [d for d in directors if (d.get("appointed_on") or "") >= _ago(today, DIRECTOR_WINDOW_DAYS)]
    for d in sorted(recent, key=lambda d: d["appointed_on"], reverse=True)[:2]:
        lines.append(f"new director {d['name']} ({d['appointed_on'][:7]}) — new people review providers")
    return lines
