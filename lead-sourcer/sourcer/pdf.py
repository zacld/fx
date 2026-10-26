"""
sourcer/pdf.py — text from PDF accounts, for the two-thirds of filings
with no tagged (iXBRL) version.

Digital PDFs: poppler's `pdftotext -layout` (keeps table rows on one line,
so "Turnover   3   45,123   41,000" stays together). Scanned paper
filings have no text layer: the first few pages are rendered with
`pdftoppm` and read with Tesseract OCR — enough for the company
information page (directors, bankers, auditors) and usually the strategic
report; deeper pages cost too much time per company.

Both are system tools (apt: poppler-utils, tesseract-ocr), installed in the
GitHub workflow. Without them every function here returns empty and the
pipeline carries on as before.
"""

from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time

OCR_MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "6"))
MIN_TEXT_CHARS = 300   # less than this from pdftotext means a scanned document
TIMEOUT_SECONDS = 90


def available() -> bool:
    return bool(shutil.which("pdftotext"))


def ocr_available() -> bool:
    return bool(shutil.which("tesseract") and shutil.which("pdftoppm"))


# Tesseract uses every core for each page; with several companies OCR'd at once
# (main.CH_WORKERS) they fight over the CPU, so each process gets one thread.
_ENV = {**os.environ, "OMP_THREAD_LIMIT": "1"}
# OCR time and pages this run, for the finder's progress line (thread-safe).
stats = {"seconds": 0.0, "pages": 0, "fx_pages": 0, "fx_seconds": 0.0}
_stats_lock = threading.Lock()


def _count(seconds: float, pages: int = 0, fx_pages: int = 0) -> None:
    with _stats_lock:
        stats["seconds"] += seconds
        stats["pages"] += pages
        stats["fx_pages"] += fx_pages
        if fx_pages:
            stats["fx_seconds"] += seconds


def _run(args: list[str]) -> str:
    try:
        done = subprocess.run(args, capture_output=True, timeout=TIMEOUT_SECONDS, check=False, env=_ENV)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return done.stdout.decode("utf-8", "replace") if done.returncode == 0 else ""


def to_text(data: bytes) -> tuple[str, str]:
    """
    (text, how): how is "pdf" (text layer), "scanned pdf" (OCR of the first
    OCR_MAX_PAGES pages) or "" when nothing could be read. Pages are
    separated by form feeds.
    """
    if not data or not available():
        return "", ""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "accounts.pdf")
        with open(path, "wb") as f:
            f.write(data)
        text = _run(["pdftotext", "-layout", path, "-"])
        if len(re.sub(r"\s", "", text)) >= MIN_TEXT_CHARS:
            return text, "pdf"
        if not ocr_available():
            return "", ""
        started = time.monotonic()
        _run(["pdftoppm", "-r", "200", "-gray", "-f", "1", "-l", str(OCR_MAX_PAGES), "-png", path,
              os.path.join(tmp, "page")])
        pages = [_run(["tesseract", image, "stdout", "--psm", "6"])
                 for image in sorted(glob.glob(os.path.join(tmp, "page*.png")))]
        _count(time.monotonic() - started, pages=len(pages))
        text = "\f".join(pages)
        return (text, "scanned pdf") if len(re.sub(r"\s", "", text)) >= MIN_TEXT_CHARS else ("", "")


# --- The FX line in a scanned filing -----------------------------------------
# The operating-profit note with the exchange gain/loss line sits 60-90% of the
# way through scanned accounts (pages 20-27 of 24-37 in the case study), well
# past the first OCR_MAX_PAGES. Those pages are read one at a time, stopping at
# the first that has the line; a per-run time budget keeps the finder within
# its minutes (each page is ~2s of OCR).
FX_SEARCH_MAX_PAGES = int(os.environ.get("OCR_FX_MAX_PAGES", "12"))
FX_SEARCH_BUDGET_SECONDS = float(os.environ.get("OCR_FX_BUDGET_SECONDS", "1800"))


def _fx_budget_left() -> bool:
    """Whether this run's FX-page OCR is under OCR_FX_BUDGET_SECONDS (all worker threads together)."""
    with _stats_lock:
        return stats["fx_seconds"] < FX_SEARCH_BUDGET_SECONDS


def _page_count(path: str) -> int:
    m = re.search(r"^Pages:\s+(\d+)", _run(["pdfinfo", path]), re.M)
    return int(m.group(1)) if m else 0


def fx_pages_order(pages: int, already: int) -> list[int]:
    """Pages to try for the FX note, best first: 60-90% of the way through, then the rest after `already`."""
    likely = list(range(max(already + 1, round(pages * 0.6)), min(pages, round(pages * 0.9)) + 1))
    rest = [p for p in range(already + 1, pages + 1) if p not in likely]
    return (likely + rest)[:FX_SEARCH_MAX_PAGES]


def ocr_find(data: bytes, wanted, already: int = OCR_MAX_PAGES) -> tuple[str, int]:
    """
    (page text, page number) of the first page after the first `already`
    that `wanted(text)` accepts, OCR'd one page at a time in fx_pages_order;
    ("", 0) when none does, OCR isn't installed or the run's budget is spent.
    """
    if not data or not ocr_available() or not _fx_budget_left():
        return "", 0
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "accounts.pdf")
        with open(path, "wb") as f:
            f.write(data)
        for number in fx_pages_order(_page_count(path), already):
            if not _fx_budget_left():
                break
            started = time.monotonic()
            stem = os.path.join(tmp, f"fx{number}")
            _run(["pdftoppm", "-r", "200", "-gray", "-f", str(number), "-l", str(number), "-png", path, stem])
            images = sorted(glob.glob(stem + "*.png"))
            text = _run(["tesseract", images[0], "stdout", "--psm", "6"]) if images else ""
            _count(time.monotonic() - started, pages=1, fx_pages=1)
            if text and wanted(text):
                return text, number
    return "", 0
