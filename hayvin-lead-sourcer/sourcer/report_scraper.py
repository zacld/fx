"""
sourcer/report_scraper.py — best-effort named-contact extraction from a
company's published sustainability/ESG report (PDF) and newsroom/press page
(HTML).

This is NOT a scraper of protected/social sources — it only reads pages a
company has itself published for public consumption (ToS-compliant, same as
fetching any other public webpage/PDF).

Confidence is deliberately conservative: a hit is only returned when a
person's name appears within a short span of one of the target job titles,
which is the "foreword" / "our team" pattern most FTSE retailers use. When
nothing is found the caller should fall back to
`source: manual_linkedin_lookup_required` per PRIORITY 12-style ToS caution
— never fabricate a name.
"""

from __future__ import annotations

import io
import re
import sys
import urllib.error
import urllib.request
from html.parser import HTMLParser
from typing import Optional

try:
    import pdfplumber
    HAVE_PDFPLUMBER = True
except ImportError:  # degrade gracefully — PDF reports just get skipped
    HAVE_PDFPLUMBER = False

USER_AGENT = "Mozilla/5.0 (compatible; HayvinLeadSourcer/1.0; +https://hayvin.example/bot)"

# Two capitalised words (+ optional middle initial/hyphen), e.g. "Jane Doe",
# "Jane A. Doe", "Anne-Marie O'Brien". Deliberately conservative — false
# positives here become fabricated-looking leads, which is worse than a miss.
NAME_RE = re.compile(
    r"\b([A-Z][a-zA-Z'-]+(?:\s+[A-Z]\.)?\s+[A-Z][a-zA-Z'-]+)\b"
)

# How close (in characters) a name and a target title must appear to count
# as the same person, e.g. "Jane Doe, Sustainability Manager" or
# "Sustainability Manager Jane Doe".
PROXIMITY_CHARS = 60

# Words that make a NAME_RE match almost certainly not a person's name.
NAME_STOPWORDS = {
    "United Kingdom", "Great Britain", "Corporate Responsibility",
    "Annual Report", "Press Release", "Media Centre", "Read More",
    "Find Out", "Learn More", "Terms Conditions", "Privacy Policy",
}


class _TextExtractor(HTMLParser):
    """Minimal stdlib HTML->text so we don't need an HTML-parsing dependency."""

    def __init__(self):
        super().__init__()
        self._chunks: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "nav", "footer"):
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style", "nav", "footer") and self._skip_depth > 0:
            self._skip_depth -= 1
        if tag in ("p", "div", "li", "br", "h1", "h2", "h3", "h4", "tr"):
            self._chunks.append("\n")

    def handle_data(self, data):
        if self._skip_depth == 0:
            self._chunks.append(data)

    def get_text(self) -> str:
        return "".join(self._chunks)


def _fetch(url: str) -> Optional[bytes]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read()
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        print(f"WARNING: could not fetch {url}: {e}", file=sys.stderr)
        return None
    except Exception as e:  # noqa: BLE001 — never let a bad page crash the run
        print(f"WARNING: could not fetch {url}: {e}", file=sys.stderr)
        return None


def _html_to_text(raw: bytes) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(raw.decode("utf-8", errors="ignore"))
    except Exception:  # noqa: BLE001
        return ""
    text = parser.get_text()
    return re.sub(r"[ \t]+", " ", text)


def _pdf_to_text(raw: bytes) -> str:
    if not HAVE_PDFPLUMBER:
        return ""
    try:
        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            # Foreword/team-section names are almost always in the first
            # ~15 pages of a sustainability report — cap it so a 200-page
            # annual report doesn't take minutes to parse.
            pages = pdf.pages[:15]
            return "\n".join(p.extract_text() or "" for p in pages)
    except Exception as e:  # noqa: BLE001 — malformed/encrypted PDFs shouldn't crash the run
        print(f"WARNING: could not parse PDF: {e}", file=sys.stderr)
        return ""


def _looks_like_name(candidate: str, known_titles: set[str]) -> bool:
    if candidate in NAME_STOPWORDS:
        return False
    if candidate.lower() in known_titles:
        return False
    words = candidate.split()
    return 2 <= len(words) <= 3


def extract_named_contacts(text: str, titles: list[str]) -> list[dict]:
    """
    Scan `text` for (name, title) pairs where a target title appears within
    PROXIMITY_CHARS of a plausible person name.
    Returns a de-duplicated list of {"name", "title"} dicts.
    """
    found: dict[tuple[str, str], dict] = {}
    known_titles = {t.lower() for t in titles}

    for title in titles:
        for title_match in re.finditer(re.escape(title), text, flags=re.IGNORECASE):
            window_start = max(0, title_match.start() - PROXIMITY_CHARS)
            window_end = min(len(text), title_match.end() + PROXIMITY_CHARS)
            window = text[window_start:window_end]
            # Blank out the title itself so it can't be mistaken for the
            # adjacent person's name (e.g. "Sustainability Manager" is two
            # capitalised words, same shape as a real name).
            local_start = title_match.start() - window_start
            local_end = title_match.end() - window_start
            window = window[:local_start] + (" " * (local_end - local_start)) + window[local_end:]

            for name_match in NAME_RE.finditer(window):
                candidate = name_match.group(1).strip()
                if not _looks_like_name(candidate, known_titles):
                    continue
                key = (candidate.lower(), title.lower())
                if key not in found:
                    found[key] = {"name": candidate, "title": title}

    return list(found.values())


def find_contacts_for_company(
    press_url: Optional[str],
    sustainability_report_url: Optional[str],
    titles: list[str],
) -> list[dict]:
    """
    Fetch a company's press page and sustainability report (if URLs given)
    and return any {"name", "title"} pairs found, tagged with which source
    they came from. Never raises — any fetch/parse failure just yields fewer
    (or zero) results.
    """
    results: list[dict] = []

    for url, source_label in (
        (sustainability_report_url, "sustainability_report"),
        (press_url, "press_page"),
    ):
        if not url:
            continue
        raw = _fetch(url)
        if raw is None:
            continue

        is_pdf = url.lower().endswith(".pdf") or raw[:4] == b"%PDF"
        text = _pdf_to_text(raw) if is_pdf else _html_to_text(raw)
        if not text:
            continue

        for hit in extract_named_contacts(text, titles):
            hit["source_url"] = url
            hit["source_type"] = source_label
            results.append(hit)

    return results
