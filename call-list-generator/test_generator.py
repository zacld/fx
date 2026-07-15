#!/usr/bin/env python3
"""
Offline test harness for generate_call_list.py — no API key, no network.

Spins up a localhost mock of the Companies House API (advanced search +
company profiles) and a handful of fake company websites, then drives the
full pipeline through it: pagination, deduplication, name-match ranking,
accounts-type filtering, 429 retry, website discovery + FX evidence
scanning, and CSV output.

Usage:
  python3 test_generator.py        # exits 0 if all tests pass
"""
import csv
import http.server
import io
import json
import os
import sys
import threading
import urllib.parse

# Local mock must not be routed through any proxy
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generate_call_list as g

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SIC_WINE_A = "46341"
SIC_WINE_B = "46342"
SIC_PAGED = "46999"
SIC_RETRY = "42999"


def co(name: str, num: str, sics: list[str], accounts="full") -> dict:
    return {
        "company_name": name,
        "company_number": num,
        "company_status": "active",
        "sic_codes": sics,
        "registered_office_address": {
            "address_line_1": "1 Test Street",
            "locality": "London",
            "postal_code": "E1 1AA",
        },
        "_accounts": accounts,   # test-only; stripped before serving
    }


COMPANIES = {
    SIC_WINE_A: [
        co("BERKMANN WINE CELLARS LIMITED", "1000001", [SIC_WINE_A]),
        co("TWINE CRAFTS LIMITED", "1000002", [SIC_WINE_A]),            # must NOT match "wine"
        co("LES CAVES DE PYRENE LIMITED", "1000003", [SIC_WINE_A], "micro-entity"),
        co("SHARED DRINKS GROUP LIMITED", "1000004", [SIC_WINE_A, SIC_WINE_B]),
    ],
    SIC_WINE_B: [
        co("SHARED DRINKS GROUP LIMITED", "1000004", [SIC_WINE_A, SIC_WINE_B]),  # dup within niche
        co("VINTNERS OF LONDON LIMITED", "1000005", [SIC_WINE_B], "group"),
        co("NO ACCOUNTS DATA LIMITED", "1000006", [SIC_WINE_B], "404"),  # profile → 404
    ],
    SIC_PAGED: [co(f"PAGED WINE COMPANY {i} LIMITED", f"2{i:06d}", [SIC_PAGED])
                for i in range(120)],
    SIC_RETRY: [co("RETRY WINES LIMITED", "3000001", [SIC_RETRY])],
}

PROFILES = {c["company_number"]: c["_accounts"]
            for items in COMPANIES.values() for c in items}

SITES = {
    "berkmann": {
        "/": "<html><h1>Berkmann Wine Cellars</h1><script>var x='import nothing';</script>"
             "<p>A leading importer of fine wines, sourced from family estates "
             "across Europe. This is important to us.</p></html>",
        "/about": "<html><p>Our overseas suppliers invoice us in euros and exchange "
                  "rate movements matter. We import and distribute nationwide.</p></html>",
    },
    "vintners": {
        "/": "<html><p>Wholesale wine list for the UK on-trade.</p></html>",  # 0 FX signals
    },
}

RETRY_STATE = {"count": 0}

# ---------------------------------------------------------------------------
# Mock server
# ---------------------------------------------------------------------------


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence
        pass

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/advanced-search/companies":
            sic = qs.get("sic_codes", [""])[0]
            start = int(qs.get("start_index", ["0"])[0])
            size = int(qs.get("size", ["50"])[0])
            if sic == SIC_RETRY and RETRY_STATE["count"] == 0:
                RETRY_STATE["count"] += 1
                self._json({"error": "rate limited"}, code=429)
                return
            items = COMPANIES.get(sic, [])
            page = [{k: v for k, v in c.items() if k != "_accounts"}
                    for c in items[start:start + size]]
            self._json({"hits": len(items), "items": page})

        elif parsed.path.startswith("/company/"):
            num = parsed.path.rsplit("/", 1)[-1]
            accounts = PROFILES.get(num)
            if accounts is None or accounts == "404":
                self._json({"error": "not found"}, code=404)
            else:
                self._json({"company_number": num,
                            "accounts": {"last_accounts": {"type": accounts}}})

        elif parsed.path.startswith("/site/"):
            rest = parsed.path[len("/site/"):]
            slug, _, page = rest.partition("/")
            page = "/" + page.rstrip("/") if page else "/"
            html = SITES.get(slug, {}).get(page)
            if html is None:
                self._send(404, b"not found", "text/html")
            else:
                self._send(200, html.encode(), "text/html")
        else:
            self._send(404, b"not found", "text/plain")


def start_server() -> str:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


# ---------------------------------------------------------------------------
# Test scaffolding
# ---------------------------------------------------------------------------

PASSED, FAILED = [], []


def check(label: str, cond: bool, detail: str = ""):
    if cond:
        PASSED.append(label)
        print(f"  PASS  {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}  {detail}")


NICHES = [
    {"id": "wine", "name": "Wine Importers",
     "sic_codes": [SIC_WINE_A, SIC_WINE_B],
     "name_keywords": ["wine", "vintners", "cellar"],
     "currency_pairs": ["EUR/GBP"], "call_angle": "angle A"},
    {"id": "second", "name": "Second Niche",
     "sic_codes": [SIC_WINE_B],
     "name_keywords": ["vintners"],
     "currency_pairs": ["EUR/GBP"], "call_angle": "angle B"},
]


def main() -> None:
    base = start_server()

    # Point the generator at the mock; drop throttling for test speed
    g.CH_SEARCH = f"{base}/advanced-search/companies"
    g.CH_COMPANY = base + "/company/{number}"
    g.RATE_LIMIT_SECONDS = 0

    def fake_candidates(name: str) -> list[str]:
        n = name.lower()
        if "berkmann" in n:
            return [f"{base}/site/berkmann/"]
        if "vintners" in n:
            return [f"{base}/site/vintners/"]
        return ["http://127.0.0.1:9/"]   # closed port → fast failure
    g._candidate_urls = fake_candidates

    print("\n[1] match_name word boundaries")
    kw = ["wine", "vintners", "cellar"]
    check("'wine' does not fire on TWINE", g.match_name("TWINE CRAFTS LIMITED", kw) is None)
    check("'gin' does not fire on ENGINEERING", g.match_name("SMITH ENGINEERING LIMITED", ["gin"]) is None)
    check("'oil' does not fire on TOILETRIES", g.match_name("TOILETRIES TRADING LTD", ["oil"]) is None)
    check("'wine' fires on WINE CELLARS", g.match_name("BERKMANN WINE CELLARS", kw) == "wine")
    check("'wine' fires on WINERY (prefix)", g.match_name("THE WINERY LIMITED", kw) == "wine")
    check("'horticultur' prefix fires", g.match_name("ACME HORTICULTURE LTD", ["horticultur"]) is not None)

    print("\n[2] domain guessing")
    # test the real implementation (reload to undo the patch), then re-patch
    import importlib
    real = importlib.reload(g)
    urls = real._candidate_urls("BERKMANN WINE CELLARS LIMITED")
    check("candidates generated", len(urls) > 0)
    check("legal suffix stripped", all("limited" not in u for u in urls), str(urls[:2]))
    check("joined-name domain present", any("berkmannwinecellars.co.uk" in u for u in urls))
    # re-apply patches after reload
    real.CH_SEARCH = f"{base}/advanced-search/companies"
    real.CH_COMPANY = base + "/company/{number}"
    real.RATE_LIMIT_SECONDS = 0
    real._candidate_urls = fake_candidates
    globals()["g"] = real

    print("\n[3] pagination")
    got = g.search_by_sic(SIC_PAGED, "test-key", 200)
    check("fetches all 120 across 3 pages", len(got) == 120, f"got {len(got)}")
    got = g.search_by_sic(SIC_PAGED, "test-key", 60)
    check("respects max_per_niche cap", len(got) == 60, f"got {len(got)}")

    print("\n[4] collect: dedup + ranking")
    rows = g.collect_companies(NICHES, "test-key", filter_accounts=False,
                               max_per_niche=200)
    nums = [r["company_number"] for r in rows]
    check("6 unique companies", len(rows) == 6, f"got {len(rows)}")
    check("no duplicate company_numbers", len(set(nums)) == len(nums))
    check("cross-niche dedup (second niche empty)",
          all(r["niche_id"] == "wine" for r in rows))
    check("name-matched ranked first",
          [r["name_match"] for r in rows][:2] == ["yes", "yes"]
          and rows[2]["name_match"] == "no")
    check("matched_keyword populated", rows[0]["matched_keyword"] in kw)

    print("\n[5] --require-name-match")
    rows = g.collect_companies(NICHES, "test-key", filter_accounts=False,
                               max_per_niche=200, require_name_match=True)
    check("only matched kept", len(rows) == 2 and all(r["name_match"] == "yes" for r in rows),
          f"got {len(rows)}")

    print("\n[6] accounts filter")
    rows = g.collect_companies(NICHES, "test-key", filter_accounts=True,
                               max_per_niche=200)
    names = {r["company_name"] for r in rows}
    check("micro-entity dropped", "LES CAVES DE PYRENE LIMITED" not in names)
    check("404 profile dropped", "NO ACCOUNTS DATA LIMITED" not in names)
    check("full + group kept", {"BERKMANN WINE CELLARS LIMITED",
                                "VINTNERS OF LONDON LIMITED"} <= names)
    check("accounts_type recorded",
          {r["accounts_type"] for r in rows} <= {"full", "group"})

    print("\n[7] website verification + FX evidence")
    rows = g.collect_companies(NICHES, "test-key", filter_accounts=False,
                               max_per_niche=200, require_name_match=True,
                               verify_websites=True)
    by_name = {r["company_name"]: r for r in rows}
    berk = by_name["BERKMANN WINE CELLARS LIMITED"]
    vint = by_name["VINTNERS OF LONDON LIMITED"]
    check("website found", berk["website"].endswith("/site/berkmann/"), berk["website"])
    check("3+ FX signals found", int(berk["fx_signal_count"]) >= 3, berk["fx_signals"])
    check("'importer' text fires import signal",
          "import" in berk["fx_signals"].split("|"), berk["fx_signals"])
    check("site with no signals scores 0", vint["fx_signal_count"] == "0", vint["fx_signals"])
    check("evidence-ranked (berkmann first)", rows[0]["company_name"].startswith("BERKMANN"))

    print("\n[7b] signal scanner unit checks")
    check("'important' alone does NOT fire import",
          "import" not in g.scan_fx_signals("<p>This is important information</p>"))
    check("'imports' fires import",
          "import" in g.scan_fx_signals("<p>We are importers of cheese</p>"))
    check("'currency' fires", "currency" in g.scan_fx_signals("<p>foreign currency accounts</p>"))
    check("import inside <script> ignored",
          "import" not in g.scan_fx_signals("<html><script>import x from 'y';</script><p>hi</p></html>"))
    check("export inside <style> ignored",
          "export" not in g.scan_fx_signals("<html><style>.export{color:red}</style><p>hi</p></html>"))

    print("\n[8] 429 retry")
    RETRY_STATE["count"] = 0
    got = g.search_by_sic(SIC_RETRY, "test-key", 50)
    check("recovers after 429", len(got) == 1, f"got {len(got)}")

    print("\n[9] CSV round-trip")
    buf_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".test_out.csv")
    rows = g.collect_companies(NICHES, "test-key", filter_accounts=False,
                               max_per_niche=200, require_name_match=True,
                               verify_websites=True)
    g.write_csv(rows, buf_path)
    with open(buf_path, newline="", encoding="utf-8") as f:
        back = list(csv.DictReader(f))
    os.remove(buf_path)
    check("row count preserved", len(back) == len(rows))
    check("all CSV_FIELDS present", back and list(back[0].keys()) == g.CSV_FIELDS)
    check("CH URL well-formed",
          back[0]["companies_house_url"].startswith(
              "https://find-and-update.company-information.service.gov.uk/company/"))

    print("\n" + "=" * 60)
    print(f"PASSED: {len(PASSED)}   FAILED: {len(FAILED)}")
    if FAILED:
        print("Failed tests:")
        for f in FAILED:
            print(f"  - {f}")
        sys.exit(1)
    print("All tests passed.")


if __name__ == "__main__":
    main()
