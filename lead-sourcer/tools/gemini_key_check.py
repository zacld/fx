"""
tools/gemini_key_check.py — does a Gemini API key work? (Zac, 25 Nov 2026: a new key added as a second secret.)

For each Gemini key secret that is set (the workflow passes every likely name), read-only and never printing the key:
  1. lists the models the key can use (the newest Flash / Pro names);
  2. makes one Google-grounded test call on the newest Flash model and on gemini-2.5-flash (the owner check's model):
     HTTP status, whether Google Search ran (sources returned), tokens used.
Errors print their status and a short message with digits masked (no project numbers in a public log).
Standard library only. Workflow "Gemini key check" (on a push of this file or its workflow, or by hand).
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

NAMES = ["GEMINI_KEY_2", "GEMINI_KEY2", "GEMINI_API_KEY_2", "GEMINI_API_KEY2", "GEMINI_2", "GEMINIKEY2", "GEMINI_API_2",
         "GEMINI_NEW", "GEMINI_API_KEY"]
BASE = "https://generativelanguage.googleapis.com/v1beta"
PROMPT = "Use Google Search to find the postcode of Companies House's head office in Cardiff. Reply with the postcode only."


def _call(url: str, key: str, body: dict | None = None) -> tuple[int, dict, str]:
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            return res.status, json.load(res), ""
    except urllib.error.HTTPError as e:
        text = e.read(2000).decode("utf-8", "replace") if e.fp else ""
        try:
            err = json.loads(text).get("error") or {}
        except ValueError:
            err = {}
        message = re.sub(r"\d{4,}", "#", " ".join(str(err.get("message") or text).split()))[:220]
        return e.code, {}, f"{err.get('status') or ''} {message}".strip()
    except Exception as e:  # noqa: BLE001
        return 0, {}, type(e).__name__


def _version(name: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", name.split("gemini-")[-1].split("-")[0])) or (0,)


def check(name: str, key: str) -> None:
    print(f"\n{name}: set")
    status, data, err = _call(f"{BASE}/models?pageSize=1000", key)
    if status != 200:
        print(f"  models: HTTP {status} {err}")
        return
    models = [m["name"].split("/")[-1] for m in data.get("models") or []
              if "generateContent" in (m.get("supportedGenerationMethods") or [])]
    flash = sorted((m for m in models if re.fullmatch(r"gemini-[\d.]+-flash(-preview)?(-\d\d-\d{4})?", m)), key=_version, reverse=True)
    pro = sorted((m for m in models if re.fullmatch(r"gemini-[\d.]+-pro(-preview)?(-\d\d-\d{4})?", m)), key=_version, reverse=True)
    print(f"  models: HTTP 200, {len(models)} usable; newest Flash: {', '.join(flash[:3]) or 'none'}; "
          f"newest Pro: {', '.join(pro[:2]) or 'none'}")
    for model in list(dict.fromkeys(flash[:1] + ["gemini-2.5-flash"])):
        body = {"contents": [{"parts": [{"text": PROMPT}]}], "tools": [{"google_search": {}}]}
        status, out, err = _call(f"{BASE}/models/{model}:generateContent", key, body)
        if status != 200:
            print(f"  {model} + Google Search: HTTP {status} {err}")
            continue
        cand = (out.get("candidates") or [{}])[0]
        text = " ".join("".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts") or []).split())
        chunks = (cand.get("groundingMetadata") or {}).get("groundingChunks") or []
        tokens = (out.get("usageMetadata") or {}).get("totalTokenCount")
        print(f"  {model} + Google Search: HTTP 200, {'searched Google' if chunks else 'NO search sources'} "
              f"({len(chunks)} sources), {tokens} tokens, answer: {text[:60]!r}")


def main() -> None:
    found = [(n, os.environ.get(n, "").strip()) for n in NAMES]
    found = [(n, k) for n, k in found if k]
    print("Gemini key secrets set: " + (", ".join(n for n, _ in found) or "none of " + ", ".join(NAMES)))
    for name, key in found:
        check(name, key)


if __name__ == "__main__":
    main()
