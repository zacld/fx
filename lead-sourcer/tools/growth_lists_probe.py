"""
tools/growth_lists_probe.py — before any list of fast-growing international companies is read automatically, what its
publisher allows (read-only; prints terms clauses, robots.txt and page shapes, no people's names):

  * the Sunday Times International Track 200 (fasttrack.co.uk): robots.txt, the terms clauses on automated access /
    copying / reuse, and whether the league table is in the page's HTML;
  * the King's Awards for Enterprise (International Trade) winners on gov.uk (Open Government Licence): which
    publications exist and in what format (HTML / CSV / PDF attachments).

Nothing is saved or used: this only decides whether an importer may be built (CLAUDE.md, Priority 12 spirit).
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "fx-lead-sourcer/1.0 (+https://github.com/zacld/fx)"
FASTTRACK = "https://www.fasttrack.co.uk"
CLAUSE = re.compile(r"[^.]{0,240}\b(?:automat\w*|scrap\w*|crawl\w*|robot\w*|spider\w*|harvest\w*|data[- ]?min\w*|"
                    r"reproduc\w*|copy\w*|republish\w*|commercial\w*|database|extract\w*|systematic\w*)\b[^.]{0,240}\.", re.I)


def get(url: str, limit: int = 3_000_000) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read(limit).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # noqa: BLE001 — a probe reports, never fails
        return 0, f"{type(e).__name__}"


def text_of(html: str) -> str:
    html = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
    return " ".join(re.sub(r"<[^>]+>", " ", html).split())


def links(html: str, base: str) -> list[str]:
    return sorted({urllib.parse.urljoin(base, h) for h in re.findall(r'href="([^"#]+)"', html)})


def fasttrack() -> None:
    print("== Fast Track (Sunday Times International Track 200) ==")
    status, robots = get(FASTTRACK + "/robots.txt")
    print(f"robots.txt: HTTP {status}\n" + "\n".join("  " + line for line in robots.splitlines()[:40]))
    status, home = get(FASTTRACK + "/")
    print(f"home: HTTP {status}, {len(home):,} chars")
    found = links(home, FASTTRACK)
    legal = [u for u in found if re.search(r"terms|legal|conditions|copyright|privacy|disclaimer", u, re.I)]
    legal += [FASTTRACK + p for p in ("/terms-of-use/", "/terms-and-conditions/", "/legal/") if FASTTRACK + p not in legal]
    for url in legal[:6]:
        status, page = get(url)
        clauses = list(dict.fromkeys(m.group(0).strip() for m in CLAUSE.finditer(text_of(page))))
        print(f"\n{url}: HTTP {status}, {len(clauses)} clauses on automated access / copying / reuse")
        for c in clauses[:15]:
            print(f"  - {c[:480]}")
    tables = [u for u in found if "international-track" in u.lower()]
    print(f"\nInternational Track links on the home page: {tables[:8]}")
    for url in (tables[:2] or [FASTTRACK + "/league-tables/international-track/"]):
        status, page = get(url)
        rows = len(re.findall(r"<tr\b", page, re.I))
        print(f"{url}: HTTP {status}, {rows} table rows in the HTML, {len(page):,} chars"
              f"{' (rendered by script?)' if not rows and page else ''}")


def kings_awards() -> None:
    print("\n== King's Awards for Enterprise winners (gov.uk) ==")
    query = urllib.parse.urlencode({"q": "King's Awards for Enterprise winners", "count": 10,
                                    "fields": "title,link,format,public_timestamp"})
    status, body = get(f"https://www.gov.uk/api/search.json?{query}")
    try:
        results = json.loads(body).get("results", []) if body else []
    except ValueError:
        results = []
    print(f"search: HTTP {status}, {len(results)} results")
    for r in results:
        print(f"  {r.get('public_timestamp', '')[:10]}  {r.get('format', '')}  {r.get('title', '')}  {r.get('link', '')}")
    for r in results[:4]:
        status, body = get("https://www.gov.uk/api/content" + r.get("link", ""))
        try:
            doc = json.loads(body) if body else {}
        except ValueError:
            doc = {}
        attachments = (doc.get("details") or {}).get("attachments") or []
        print(f"\n{r.get('link')}: HTTP {status}, {len(attachments)} attachments")
        for a in attachments[:10]:
            print(f"  {a.get('content_type', '')}  {a.get('title', '')}  {a.get('url', '')}")


if __name__ == "__main__":
    fasttrack()
    kings_awards()
