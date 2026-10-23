"""
sourcer/qualify.py — qualify out hard, and flag warm routes in.

  qualified       "Yes" / "Check" / "Out"
  qualify_reason  why, from the row's own evidence
  warm_route      a way in that isn't a cold call: an existing relationship with
                  your bank, a private-equity sponsor, an introducer auditor

Rules are in QUALIFY_RULES, to tune against what actually converts. This
filters the list (the Accounts page hides "Out" by default); it doesn't
change the ranking.
"""

from __future__ import annotations

import os
from typing import Optional

from sourcer import hooks

QUALIFY_RULES = {
    "out_foreign_parent": True,        # owned by a company registered abroad: FX likely run by group treasury there
    "out_no_fx_evidence": True,        # nothing but the niche default: no customs records, no FX in the accounts
    "check_sophisticated": True,       # hedges with forwards and a Big Four auditor: a treasury that's hard to win
    "check_net_liabilities": True,     # net liabilities on the balance sheet: check before calling
}
# Audit/accountancy firms your bank gets introductions from, comma-separated (repository variable WARM_AUDITORS).
WARM_AUDITORS_ENV = "WARM_AUDITORS"

YES, CHECK, OUT = "Yes", "Check", "Out"


def warm_auditors() -> list[str]:
    return [a.strip().upper() for a in os.environ.get(WARM_AUDITORS_ENV, "").split(",") if a.strip()]


def assess(owners: list[dict], facts: Optional[dict], exposure: dict, fx_today: str, customs_months: int,
           own_bank: bool, own_bank_name: str, pe_sponsor: str) -> dict:
    """{"qualified", "qualify_reason", "warm_route"} for one checked company."""
    f = facts or {}
    rules = QUALIFY_RULES
    outs, checks, warm = [], [], []

    parent = next((o for o in owners if o.get("kind") == "corporate" and not o.get("ceased_on")
                   and o.get("country") and not hooks.is_uk(o["country"])), None)
    if rules["out_foreign_parent"] and parent:
        outs.append(f"owned by {parent['name']} ({parent['country']}): FX likely run by group treasury abroad")
    if rules["out_no_fx_evidence"] and exposure.get("confidence") in ("", hooks.LOW) and not customs_months \
            and f.get("fx_gain_loss") is None and not fx_today:
        outs.append("no FX evidence beyond the niche (no customs records, nothing in the accounts)")
    if rules["check_sophisticated"] and fx_today == "Uses forward contracts" and f.get("auditor_tier") == "Big Four":
        checks.append(f"hedges with forwards and is audited by {f.get('auditor', 'a Big Four firm')}: a set-up treasury")
    net = f.get("net_assets")
    if rules["check_net_liabilities"] and net is not None and net < 0:
        checks.append(f"net liabilities of {hooks.exact(net)} in the latest accounts")

    if own_bank:
        warm.append(f"existing {own_bank_name or 'own-bank'} relationship (charge or bankers line)")
    if pe_sponsor:
        warm.append(f"private-equity backed ({pe_sponsor}): route in through the sponsor")
    auditor = (f.get("auditor") or "").upper()
    if auditor and any(a in auditor for a in warm_auditors()):
        warm.append(f"auditor {f.get('auditor')} is an introducer")

    status = OUT if outs else CHECK if checks else YES
    return {"qualified": status, "qualify_reason": "; ".join(outs or checks), "warm_route": "; ".join(warm)}


COLUMNS = ["qualified", "qualify_reason", "warm_route"]
