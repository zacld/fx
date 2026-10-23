"""
audit_leads.py — Lead quality audit report.

Read-only — prints a comprehensive QA report, no writes to disk.
Run: python3.11 scripts/audit_leads.py [--json]

Exit code 0 = clean, 1 = warnings found.
"""

import json, re, sys
from pathlib import Path
from collections import Counter, defaultdict
from datetime import datetime, timezone

ROOT      = Path(__file__).parent.parent
DATA_FILE = ROOT / "data" / "leads.json"

# Minimal blocked-domain set (mirrors blocklists.ts)
BLOCKED_DOMAINS = {
    "yell.com","yelp.com","linkedin.com","facebook.com","instagram.com",
    "twitter.com","x.com","amazon.co.uk","amazon.com","ebay.co.uk","ebay.com",
    "companieshouse.gov.uk","find-and-update.company-information.service.gov.uk",
    "crunchbase.com","pitchbook.com","zoominfo.com","apollo.io","trustpilot.com",
    "glassdoor.com","reed.co.uk","indeed.com","totaljobs.com","cv-library.co.uk",
    "rightmove.co.uk","zoopla.co.uk","booking.com","tripadvisor.com",
    "companies.house.gov.uk","endole.co.uk","duedil.com","opencorporates.com",
    "thomasnet.com","alibaba.com","europages.com","europages.co.uk",
    "wikipedia.org","google.com","google.co.uk","bing.com",
}

# ── ANSI colours ──────────────────────────────────────────────────────────────
def c(text, code): return f"\033[{code}m{text}\033[0m"
RED    = lambda t: c(t, "91")
YELLOW = lambda t: c(t, "93")
GREEN  = lambda t: c(t, "92")
CYAN   = lambda t: c(t, "96")
BOLD   = lambda t: c(t, "1")
DIM    = lambda t: c(t, "2")

def bar(n, total, width=40):
    filled = int(width * n / max(total, 1))
    return "█" * filled + DIM("░") * (width - filled)

def pct(n, total):
    return f"{100*n/max(total,1):.0f}%"

def domain_of(url):
    try:
        from urllib.parse import urlparse
        h = urlparse(url).hostname or ""
        return re.sub(r"^www\d*\.", "", h.lower())
    except Exception:
        return ""


def main():
    as_json = "--json" in sys.argv

    with open(DATA_FILE) as f:
        data = json.load(f)
    leads = [v for v in data.values() if isinstance(v, dict)]
    total = len(leads)

    warnings = []

    # ── Score buckets ──────────────────────────────────────────────────────
    hot   = [l for l in leads if l.get("priority") == "HOT"  or l.get("score", 0) >= 80]
    warm  = [l for l in leads if l.get("priority") == "WARM" and l.get("score", 0) < 80]
    queue = [l for l in leads if 40 <= l.get("score", 0) < 60 and l.get("priority") not in ("HOT","WARM")]
    skip  = [l for l in leads if l.get("score", 0) < 40 and l.get("priority") not in ("HOT","WARM","QUEUE")]

    # ── Route grades ──────────────────────────────────────────────────────
    grade_counts = Counter(l.get("route_grade", "?") for l in leads)
    grade_descs = {
        "A": "Named FD/CFO/MD + verified contact",
        "B": "Named FD/CFO/MD + guessed contact",
        "C": "Named person (any tier) + contact route",
        "D": "Company contact only, no named person",
        "E": "Website only",
        "F": "Nothing useful",
        "?": "Not yet enriched",
    }

    # ── FX likelihood ─────────────────────────────────────────────────────
    fx_strong   = [l for l in leads if (l.get("fx_likelihood_score") or 0) >= 70]
    fx_moderate = [l for l in leads if 45 <= (l.get("fx_likelihood_score") or 0) < 70]
    fx_weak     = [l for l in leads if 25 <= (l.get("fx_likelihood_score") or 0) < 45]
    fx_none     = [l for l in leads if (l.get("fx_likelihood_score") or 0) < 25]

    # ── Call readiness ────────────────────────────────────────────────────
    cr_counts = Counter(l.get("call_readiness", "unscored") for l in leads)

    # ── Data completeness ─────────────────────────────────────────────────
    missing_grade    = [l for l in leads if not l.get("route_grade")]
    missing_dms      = [l for l in leads if not l.get("decision_makers")]
    missing_snippets = [l for l in leads if not l.get("fx_evidence_snippets")]
    missing_pairs    = [l for l in leads if not l.get("inferred_currency_pairs")]
    missing_phone    = [l for l in leads if not l.get("contact_phone")]
    missing_website  = [l for l in leads if not l.get("website")]

    # ── Domain issues ─────────────────────────────────────────────────────
    domain_to_leads = defaultdict(list)
    blocked_leads   = []
    for l in leads:
        dom = domain_of(l.get("website", ""))
        if not dom:
            continue
        domain_to_leads[dom].append(l)
        if dom in BLOCKED_DOMAINS or any(dom.endswith(f".{b}") for b in BLOCKED_DOMAINS):
            blocked_leads.append(l)

    duplicate_domains = {d: ls for d, ls in domain_to_leads.items() if len(ls) > 1}

    # ── Anomalies ─────────────────────────────────────────────────────────
    grade_ab_low_fx = [
        l for l in leads
        if l.get("route_grade") in ("A", "B")
        and (l.get("fx_likelihood_score") or 0) < 45
    ]
    high_fx_weak_grade = [
        l for l in leads
        if (l.get("fx_likelihood_score") or 0) >= 70
        and l.get("route_grade") in ("D", "E", "F", None)
    ]
    hot_no_contact = [
        l for l in hot
        if not l.get("contact_phone") and not l.get("contact_email") and not l.get("contact_page")
    ]
    hot_weak_grade = [l for l in hot if l.get("route_grade") in ("D", "E", "F")]

    # ── Events ────────────────────────────────────────────────────────────
    event_ids = Counter(l.get("event_id", "?") for l in leads)

    # ── JSON output ───────────────────────────────────────────────────────
    if as_json:
        report = {
            "total": total,
            "hot": len(hot), "warm": len(warm), "queue": len(queue), "skip": len(skip),
            "grade_distribution": dict(grade_counts),
            "fx_likelihood": {
                "strong_70plus": len(fx_strong),
                "moderate_45_69": len(fx_moderate),
                "weak_25_44": len(fx_weak),
                "none_0_24": len(fx_none),
            },
            "call_readiness": dict(cr_counts),
            "missing": {
                "route_grade": len(missing_grade),
                "decision_makers": len(missing_dms),
                "evidence_snippets": len(missing_snippets),
                "currency_pairs": len(missing_pairs),
                "phone": len(missing_phone),
                "website": len(missing_website),
            },
            "domain_issues": {
                "blocked": len(blocked_leads),
                "duplicate_groups": len(duplicate_domains),
            },
            "anomalies": {
                "grade_ab_low_fx": len(grade_ab_low_fx),
                "high_fx_weak_grade": len(high_fx_weak_grade),
                "hot_no_contact": len(hot_no_contact),
                "hot_weak_grade": len(hot_weak_grade),
            },
        }
        print(json.dumps(report, indent=2))
        return 0

    # ── Terminal report ───────────────────────────────────────────────────
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    print()
    print(BOLD("═" * 62))
    print(BOLD(f"  FX Discovery — Lead Quality Audit"))
    print(BOLD(f"  {total} leads · {len(event_ids)} events · {now}"))
    print(BOLD("═" * 62))

    # Pipeline health
    print()
    print(BOLD("PIPELINE HEALTH"))
    print(f"  {GREEN('HOT')}   {len(hot):>4}  {bar(len(hot), total, 35)}  {pct(len(hot), total)}")
    print(f"  {YELLOW('WARM')}  {len(warm):>4}  {bar(len(warm), total, 35)}  {pct(len(warm), total)}")
    print(f"  QUEUE {len(queue):>4}  {bar(len(queue), total, 35)}  {pct(len(queue), total)}")
    print(f"  {DIM('SKIP')}  {len(skip):>4}  {bar(len(skip), total, 35)}  {pct(len(skip), total)}")

    # Route grades
    print()
    print(BOLD("ROUTE GRADES"))
    for g in ["A", "B", "C", "D", "E", "F", "?"]:
        n = grade_counts.get(g, 0)
        if n == 0:
            continue
        col = GREEN if g in ("A", "B") else (YELLOW if g == "C" else (RED if g in ("E", "F") else str))
        print(f"  {col(g):>2}  {n:>4}  {bar(n, total, 35)}  {DIM(grade_descs.get(g, ''))}")

    # FX likelihood
    print()
    print(BOLD("FX LIKELIHOOD SCORE"))
    print(f"  {GREEN('Strong  70+'):14}  {len(fx_strong):>4}  {bar(len(fx_strong), total, 35)}")
    print(f"  {YELLOW('Moderate 45–69'):14}  {len(fx_moderate):>4}  {bar(len(fx_moderate), total, 35)}")
    print(f"  Weak     25–44  {len(fx_weak):>4}  {bar(len(fx_weak), total, 35)}")
    print(f"  {DIM('None      0–24'):14}  {len(fx_none):>4}  {bar(len(fx_none), total, 35)}")

    # Call readiness
    print()
    print(BOLD("CALL READINESS"))
    if cr_counts.get("unscored", 0) == total:
        print(f"  {YELLOW('Not yet computed — run scripts/compute_call_readiness.py')}")
    else:
        ready  = cr_counts.get("READY", 0)
        review = cr_counts.get("REVIEW", 0)
        hold   = cr_counts.get("HOLD", 0)
        print(f"  {GREEN('READY')}   {ready:>4}  {bar(ready, total, 35)}  {pct(ready, total)}")
        print(f"  {YELLOW('REVIEW')}  {review:>4}  {bar(review, total, 35)}  {pct(review, total)}")
        print(f"  HOLD    {hold:>4}  {bar(hold, total, 35)}  {pct(hold, total)}")

    # Data completeness
    print()
    print(BOLD("DATA COMPLETENESS"))
    fields = [
        ("route_grade",        missing_grade,    "enrichment not run"),
        ("decision_makers",    missing_dms,      "no CH number or website"),
        ("evidence_snippets",  missing_snippets, "no product/supplier page found"),
        ("currency_pairs",     missing_pairs,    "no country signals on website"),
        ("contact_phone",      missing_phone,    "not published on website"),
        ("website",            missing_website,  "CH-only lead, no web presence"),
    ]
    for name, missing_list, note in fields:
        n = len(missing_list)
        ok = n == 0
        icon = GREEN("✓") if ok else (YELLOW("⚠") if n < total * 0.3 else RED("✗"))
        frac = f"{total - n}/{total}"
        msg  = GREEN(f"complete") if ok else f"{n} missing  {DIM(note)}"
        print(f"  {icon}  {name:<24}  {frac:>9}  {msg}")
        if n > 0 and not ok:
            warnings.append(f"{n} leads missing {name}")

    # Domain issues
    print()
    print(BOLD("DOMAIN ISSUES"))
    if blocked_leads:
        print(f"  {RED('✗')}  Blocked domains in pipeline:  {len(blocked_leads)}")
        for l in blocked_leads[:5]:
            print(f"       {l.get('company_name','?')[:40]}  →  {domain_of(l.get('website',''))}")
        warnings.append(f"{len(blocked_leads)} leads with blocked domains")
    else:
        print(f"  {GREEN('✓')}  No blocked domains in pipeline")

    if duplicate_domains:
        print(f"  {YELLOW('⚠')}  Duplicate domains: {len(duplicate_domains)} groups")
        for dom, dups in list(duplicate_domains.items())[:5]:
            names = [d.get("company_name", "?")[:30] for d in dups]
            print(f"       {dom}  →  {', '.join(names)}")
        warnings.append(f"{len(duplicate_domains)} duplicate domain groups")
    else:
        print(f"  {GREEN('✓')}  No duplicate domains")

    # Anomalies
    print()
    print(BOLD("ANOMALIES"))
    anomalies = [
        (grade_ab_low_fx,    "Grade A/B leads with FX likelihood < 45",
         "good contact, weak evidence — worth checking website manually"),
        (high_fx_weak_grade, "FX likelihood ≥ 70 with Grade D/E/F",
         "strong evidence, no named contact — try harder on DM lookup"),
        (hot_weak_grade,     "HOT leads with Grade D/E/F",
         "scoring passed but no named contact route"),
        (hot_no_contact,     "HOT leads with no phone or email at all",
         "nothing to call or email — should be capped lower"),
    ]
    any_anomaly = False
    for lst, label, advice in anomalies:
        if lst:
            any_anomaly = True
            print(f"  {YELLOW('⚠')}  {label}:  {len(lst)}")
            print(f"       {DIM(advice)}")
            for l in lst[:3]:
                print(f"       · {l.get('company_name','?')[:45]}  grade={l.get('route_grade','?')}  fx={l.get('fx_likelihood_score','?')}")
            warnings.append(f"{len(lst)} {label}")
    if not any_anomaly:
        print(f"  {GREEN('✓')}  No anomalies detected")

    # Events
    print()
    print(BOLD("EVENTS"))
    for eid, n in sorted(event_ids.items(), key=lambda x: -x[1])[:8]:
        print(f"  {eid[:20]}  {n:>4} leads  {bar(n, total, 20)}")

    # Summary
    print()
    print(BOLD("═" * 62))
    if warnings:
        print(BOLD(f"  {len(warnings)} warning(s) found:"))
        for w in warnings:
            print(f"  {YELLOW('·')}  {w}")
    else:
        print(GREEN(BOLD("  ✓  All checks passed — pipeline data looks clean")))
    print(BOLD("═" * 62))
    print()

    return 1 if warnings else 0


if __name__ == "__main__":
    sys.exit(main())
