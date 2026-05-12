"""
qa_report.py — Post-pipeline quality report.

Prints a concise summary of lead quality after the pipeline runs.
Run manually after the pipeline or add to the end of run_pipeline.py.

Usage:
    python scripts/qa_report.py
"""

import json, re
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone
from urllib.parse import urlparse


def extract_domain(url: str) -> str:
    """Extract bare domain from a URL string."""
    if not url:
        return ""
    try:
        netloc = urlparse(url).netloc.lower()
        return netloc.replace("www.", "") or url
    except Exception:
        return url

DATA_DIR    = Path(__file__).parent.parent / "data"
LEADS_FILE  = DATA_DIR / "leads.json"
EVENTS_FILE = DATA_DIR / "events.json"


def load():
    leads  = json.loads(LEADS_FILE.read_text()) if LEADS_FILE.exists() else {}
    events = json.loads(EVENTS_FILE.read_text()) if EVENTS_FILE.exists() else {}
    return leads, events


def priority_color(p):
    return {"HOT": "🔴", "WARM": "🟠", "QUEUE": "🟡", "SKIP": "⚪"}.get(p, "❓")


def conf_icon(c):
    return {"high": "✅", "medium": "🟡", "low": "🔸", "none": "❌", None: "—"}.get(c, "—")


def main():
    leads, events = load()

    if not leads:
        print("No leads found in data/leads.json")
        return

    now = datetime.now(timezone.utc)
    print()
    print("╔══════════════════════════════════════════════════════════════╗")
    print("  FX Discovery — Pipeline Quality Report")
    print(f"  Generated: {now.strftime('%Y-%m-%d %H:%M')} UTC")
    print("╚══════════════════════════════════════════════════════════════╝")
    print()

    # ── 1. TOTALS ─────────────────────────────────────────────────────────────
    total = len(leads)
    by_source   = defaultdict(int)
    by_priority = defaultdict(int)
    by_conf     = defaultdict(int)
    by_exp_conf = defaultdict(int)

    fx_2plus        = 0
    has_director    = 0
    has_website     = 0
    has_ch          = 0
    multi_event     = 0

    for l in leads.values():
        by_source[l.get("company_source","unknown")] += 1
        by_priority[l.get("priority","?")] += 1
        by_conf[l.get("website_confidence","none")] += 1
        by_exp_conf[l.get("exposure_confidence","none")] += 1
        if len(l.get("fx_payment_signals",[])) >= 2:
            fx_2plus += 1
        if l.get("director_name"):
            has_director += 1
        if l.get("website"):
            has_website += 1
        if l.get("company_number"):
            has_ch += 1
        if l.get("multi_event_trigger"):
            multi_event += 1

    print(f"{'TOTAL LEADS':30} {total}")
    print()

    print("SOURCE BREAKDOWN")
    for src, n in sorted(by_source.items()):
        pct = round(100*n/total)
        print(f"  {src:<28} {n:>4}  ({pct}%)")
    print()

    print("PRIORITY BREAKDOWN")
    for p in ["HOT","WARM","QUEUE","SKIP"]:
        n = by_priority.get(p,0)
        bar = "█" * min(40, n)
        print(f"  {priority_color(p)} {p:<8} {n:>4}  {bar}")
    print()

    print("WEBSITE CONFIDENCE")
    for c in ["high","medium","low","none"]:
        n = by_conf.get(c,0)
        print(f"  {conf_icon(c)} {c:<10} {n:>4}")
    print()

    print("EXPOSURE CONFIDENCE")
    for c in ["high","medium","low","none"]:
        n = by_exp_conf.get(c,0)
        print(f"  {conf_icon(c)} {c:<10} {n:>4}")
    print()

    print("EVIDENCE QUALITY")
    print(f"  Leads with 2+ FX signals:    {fx_2plus}")
    print(f"  Leads with director name:    {has_director}")
    print(f"  Leads with website:          {has_website}")
    print(f"  Leads validated on CH:       {has_ch}")
    print(f"  Multi-event trigger:         {multi_event}")
    print()

    # ── 2. TOP 20 LEADS ───────────────────────────────────────────────────────
    print("═" * 68)
    print("  TOP 20 LEADS BY SCORE")
    print("═" * 68)

    top = sorted(leads.items(), key=lambda x: -x[1].get("score",0))[:20]

    for i, (lid, l) in enumerate(top, 1):
        p    = l.get("priority","?")
        s    = l.get("score",0)
        name = l.get("company_name","?")[:35]
        dom  = (extract_domain(l.get("website","")) or "—")[:30]
        wc   = l.get("website_confidence","?")
        ec   = l.get("exposure_confidence","?")
        src  = "WEB" if l.get("company_source")=="web_search" else " CH"
        fx_n = len(l.get("fx_payment_signals",[]))
        b2b_n= len(l.get("b2b_signals",[]))
        ch_v = "✓" if l.get("company_number") else "—"
        dir_ = "✓" if l.get("director_name") else "—"
        seg  = l.get("segment_name","?")[:25]
        ev   = (l.get("event_headline") or l.get("trigger_headline") or "?")[:40]

        print(f"\n  #{i:02d} {priority_color(p)} [{p} {s}] [{src}] {name}")
        print(f"       Domain:  {dom}  (web_conf:{wc}  exp_conf:{ec})")
        print(f"       Signals: FX={fx_n}  B2B={b2b_n}  CH:{ch_v}  Dir:{dir_}")
        print(f"       Segment: {seg}")
        print(f"       Event:   {ev}")

        # Show top scoring reasons
        for r in l.get("scoring_reasons",[])[:3]:
            print(f"       → {r[:70]}")

    print()

    # ── 3. CALL-WORTHY SUMMARY ────────────────────────────────────────────────
    def _call_eligible(l, min_score=0, require_direct_fx=False):
        has_direct_fx = len(l.get("fx_payment_signals",[])) >= 1
        has_fx_ev = has_direct_fx or l.get("pays_fx_confirmed")
        return (
            l.get("priority") in ("HOT","WARM")
            and l.get("website")
            and l.get("website_confidence") in ("high","medium","confirmed")
            and has_fx_ev
            and (not require_direct_fx or has_direct_fx)
            and l.get("score",0) >= min_score
            and l.get("director_name")
            and l.get("outreach_status") != "not_relevant"
        )

    priority_list = [l for l in leads.values() if _call_eligible(l, min_score=90, require_direct_fx=True)]
    extended_list = [l for l in leads.values() if _call_eligible(l, min_score=0, require_direct_fx=False)
                     and l not in priority_list]

    def _print_call_entry(l):
        p    = l.get("priority","?")
        s    = l.get("score",0)
        name = l.get("company_name","?")[:38]
        dir_ = l.get("director_name","?")
        dom  = extract_domain(l.get("website","")) or "—"
        fx   = l.get("fx_payment_signals",[])
        print(f"  {priority_color(p)} [{p} {s}] {name}")
        print(f"     Director: {dir_}  |  {dom}")
        if fx:
            print(f"     FX signals: {', '.join(fx[:3])}")
        print()

    print("═" * 68)
    print(f"  PRIORITY CALL LIST  (HOT score≥90 + direct FX signal + director)")
    print(f"  {len(priority_list)} leads")
    print("═" * 68)
    for l in sorted(priority_list, key=lambda x: -x.get("score",0)):
        _print_call_entry(l)

    print("═" * 68)
    print(f"  EXTENDED CALL LIST  (HOT/WARM + FX evidence + director)")
    print(f"  {len(extended_list)} additional leads")
    print("═" * 68)
    for l in sorted(extended_list, key=lambda x: -x.get("score",0)):
        _print_call_entry(l)

    # ── 4. QUALITY WARNINGS ───────────────────────────────────────────────────
    print("═" * 68)
    print("  QUALITY WARNINGS")
    print("═" * 68)

    warnings = []

    # Check for suspicious domains (known bad patterns that may have slipped through)
    suspicious_patterns = [
        "wikipedia", "grokipedia", "wiki", "directory", "listing",
        "index", "catalogue", "catalog", "search", "find", "locate",
        "compare", "review", "trustpilot", "glassdoor",
        "ensun", "craft.co", "zoominfo", "apollo",
    ]
    for lid, l in leads.items():
        dom = extract_domain(l.get("website",""))
        for p in suspicious_patterns:
            if p in dom:
                warnings.append(f"⚠ Suspicious domain: {dom} — {l.get('company_name','')[:35]} [{l.get('priority','')} {l.get('score',0)}]")
                break

    # Check for leads with no FX evidence (no fx_payment_signals AND no pays_fx_confirmed)
    for lid, l in leads.items():
        if (l.get("priority") == "HOT"
                and not l.get("fx_payment_signals")
                and not l.get("pays_fx_confirmed")):
            dom = extract_domain(l.get("website","")) or "—"
            warnings.append(f"⚠ HOT with no FX evidence: {l.get('company_name','')[:35]} — {dom}")

    # Check for leads with no website
    no_web = [l for l in leads.values() if not l.get("website")]
    if no_web:
        warnings.append(f"⚠ {len(no_web)} leads have no website")

    # Check for leads with generic/empty exposure thesis
    for lid, l in leads.items():
        thesis = l.get("why_affected","")
        if len(thesis) < 40:
            warnings.append(f"⚠ Thin exposure thesis: {l.get('company_name','')[:35]} — '{thesis[:40]}'")

    # Duplicate domain check
    domain_counts: dict[str,list] = defaultdict(list)
    for lid, l in leads.items():
        d = extract_domain(l.get("website",""))
        if d:
            domain_counts[d].append(l.get("company_name",""))
    for d, names in domain_counts.items():
        if len(names) > 1:
            warnings.append(f"⚠ Duplicate domain: {d} → {names}")

    if warnings:
        for w in warnings[:20]:
            print(f"  {w}")
    else:
        print("  ✅ No quality warnings detected")

    print()
    print("═" * 68)
    print(f"  Report complete — {total} leads, {len(priority_list) + len(extended_list)} call-worthy")
    print("═" * 68)
    print()


if __name__ == "__main__":
    main()
