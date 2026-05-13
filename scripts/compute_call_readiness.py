"""
compute_call_readiness.py — Derive call_readiness field for every lead.

READY   HOT/WARM + Grade A/B + fx_likelihood >= 70 + website_confidence high/medium
REVIEW  HOT/WARM + Grade A/B/C + fx_likelihood >= 45 + has website
HOLD    everything else (weak route, weak evidence, QUEUE, no website)

Also writes call_readiness_reasons: list of strings explaining what's missing.

Run: python3.11 scripts/compute_call_readiness.py [--force]
Idempotent — skips leads that already have call_readiness unless --force.
"""

import json, logging, re, shutil, sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

ROOT      = Path(__file__).parent.parent
DATA_FILE = ROOT / "data" / "leads.json"

FORCE = "--force" in sys.argv

GOOD_WEB_CONF = {"high", "medium", "confirmed"}
GOOD_GRADES   = {"A", "B"}
OK_GRADES     = {"A", "B", "C"}


def call_readiness(lead: dict) -> tuple[str, list[str]]:
    """
    Return (status, reasons_missing).
    status: "READY" | "REVIEW" | "HOLD"
    reasons_missing: list of human-readable strings describing what's holding it back.

    FX evidence is assessed in two ways:
      Strong FX:  fx_likelihood_score >= 45 (Python intelligence), OR
                  pays_fx_confirmed = True (TS pipeline), OR
                  signal_count >= 3 (TS pipeline keyword matches)
      Any FX:     any fx_payment_signals present, OR pays_fx_confirmed, OR fx_likelihood >= 25
    """
    priority     = lead.get("priority", "")
    score        = lead.get("score", 0) or 0
    grade        = lead.get("route_grade", "") or ""
    fx_score     = lead.get("fx_likelihood_score") or 0
    web_conf     = (lead.get("website_confidence") or "").lower()
    has_website  = bool(lead.get("website"))
    sig_count    = lead.get("signal_count") or len(lead.get("fx_payment_signals") or [])
    fx_confirmed = bool(lead.get("pays_fx_confirmed"))

    is_hot_warm    = priority in ("HOT", "WARM") or score >= 60
    is_high_conf   = web_conf in GOOD_WEB_CONF
    is_good_grade  = grade in GOOD_GRADES
    is_ok_grade    = grade in OK_GRADES

    # Strong FX: confirmed by TS pipeline or Python intelligence scorer
    is_strong_fx = fx_confirmed or fx_score >= 45 or sig_count >= 3
    # Any FX: at least some signal present
    is_any_fx    = bool(lead.get("fx_payment_signals")) or fx_confirmed or fx_score >= 25

    missing = []

    # Gate 1: score/priority
    if not is_hot_warm:
        missing.append(f"score too low ({score})")
    # Gate 2: route grade (named Tier-1 contact)
    if not is_good_grade:
        missing.append(f"route grade {grade or 'missing'} — need A or B (named FD/MD + contact)")
    # Gate 3: FX evidence (broader definition — TS signals count)
    if not is_strong_fx:
        detail = f"fx_likelihood={fx_score}% signals={sig_count}"
        missing.append(f"FX evidence weak ({detail}) — need confirmed/likelihood≥45/signals≥3")
    # Gate 4: website confidence
    if not is_high_conf:
        missing.append(f"website confidence {web_conf or 'unknown'} — need high/medium")
    if not has_website:
        missing.append("no website")

    if not missing:
        return "READY", []

    # REVIEW: hot/warm + at least grade C + some FX evidence + has website
    if is_hot_warm and is_ok_grade and is_any_fx and has_website:
        return "REVIEW", missing

    return "HOLD", missing


def main():
    log.info("=== Call Readiness Computation ===")

    with open(DATA_FILE) as f:
        data = json.load(f)

    is_dict = isinstance(data, dict)
    leads   = list(data.values()) if is_dict else data
    keys    = list(data.keys())   if is_dict else None

    counts  = {"READY": 0, "REVIEW": 0, "HOLD": 0, "skipped": 0}
    updated = 0

    for lead in leads:
        if not isinstance(lead, dict):
            continue

        if not FORCE and lead.get("call_readiness"):
            counts["skipped"] += 1
            continue

        status, reasons = call_readiness(lead)
        lead["call_readiness"]         = status
        lead["call_readiness_reasons"] = reasons
        counts[status] = counts.get(status, 0) + 1
        updated += 1

    # Save
    out = {keys[i]: leads[i] for i in range(len(leads))} if is_dict else leads
    with open(DATA_FILE, "w") as f:
        json.dump(out, f, indent=2)

    # Copy to public dirs
    for dst in [
        ROOT / "public" / "data" / "leads.json",
        ROOT / "apps" / "web" / "public" / "data" / "leads.json",
    ]:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(DATA_FILE, dst)

    log.info(
        "Updated %d leads — READY: %d  REVIEW: %d  HOLD: %d  (skipped %d already scored)",
        updated, counts["READY"], counts["REVIEW"], counts["HOLD"], counts["skipped"],
    )

    # Quick anomaly summary
    ready_leads  = [l for l in leads if isinstance(l, dict) and l.get("call_readiness") == "READY"]
    review_leads = [l for l in leads if isinstance(l, dict) and l.get("call_readiness") == "REVIEW"]
    log.info("READY leads: top 5 by score:")
    for l in sorted(ready_leads, key=lambda x: x.get("score", 0), reverse=True)[:5]:
        log.info(
            "  %-42s  score=%s  grade=%s  fx=%s%%",
            l.get("company_name", "?")[:42],
            l.get("score", "?"),
            l.get("route_grade", "?"),
            l.get("fx_likelihood_score", "?"),
        )
    if review_leads:
        log.info("REVIEW leads (sample — missing one key field):")
        for l in sorted(review_leads, key=lambda x: x.get("score", 0), reverse=True)[:3]:
            log.info(
                "  %-42s  %s",
                l.get("company_name", "?")[:42],
                " · ".join(l.get("call_readiness_reasons", [])),
            )


if __name__ == "__main__":
    main()
