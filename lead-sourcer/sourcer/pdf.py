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

OCR_MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "6"))
MIN_TEXT_CHARS = 300   # less than this from pdftotext means a scanned document
TIMEOUT_SECONDS = 90


def available() -> bool:
    return bool(shutil.which("pdftotext"))


def ocr_available() -> bool:
    return bool(shutil.which("tesseract") and shutil.which("pdftoppm"))


def _run(args: list[str]) -> str:
    try:
        done = subprocess.run(args, capture_output=True, timeout=TIMEOUT_SECONDS, check=False)
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
        _run(["pdftoppm", "-r", "200", "-gray", "-f", "1", "-l", str(OCR_MAX_PAGES), "-png", path,
              os.path.join(tmp, "page")])
        pages = [_run(["tesseract", image, "stdout", "--psm", "6"])
                 for image in sorted(glob.glob(os.path.join(tmp, "page*.png")))]
        text = "\f".join(pages)
        return (text, "scanned pdf") if len(re.sub(r"\s", "", text)) >= MIN_TEXT_CHARS else ("", "")
