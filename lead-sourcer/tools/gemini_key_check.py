"""
tools/gemini_key_check.py — does a Gemini API key work? (Zac, 25 Nov 2026: a new key added as a second secret.)

For each Gemini key secret that is set (the workflow passes every likely name), read-only and never printing the key:
  1. lists the models the key can use (the newest Flash / Pro names);
  2. makes one Google-grounded test call on the newest Flash model and on gemini-2.5-flash (the owner check's model):
     HTTP status, whether Google Search ran (sources returned), tokens used.
Errors print their status and a short message with digits masked (no project numbers in a public log).
Standard library only. Workflow "Gemini key check" (on a push of this file or its workflow, or by hand; a
re-run isn't open to the coding agent, so a check is re-run by pushing a change here).
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


def _call(url: str, key: str, body: dict | None = None, timeout: int = 60) -> tuple[int, dict, str]:
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
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
    aliases = [m for m in models if m.endswith("-latest")]
    pro = sorted((m for m in models if re.fullmatch(r"gemini-[\d.]+-pro(-preview)?(-\d\d-\d{4})?", m)), key=_version, reverse=True)
    print(f"  models: HTTP 200, {len(models)} usable; newest Flash: {', '.join(flash[:3]) or 'none'}; "
          f"newest Pro: {', '.join(pro[:2]) or 'none'}; aliases: {', '.join(aliases) or 'none'}")
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


def owner_lookup(name: str, key: str, model: str) -> None:
    """One real owner-check call (sourcer/owner_search.gemini_read) on a public company, in a fresh process so its
    model choice and the key stay local: does the newest Flash model search Google and pass the grounding rule?"""
    import subprocess
    import sys
    code = ("import json,sys; sys.path.insert(0, '.'); from sourcer import owner_search as o; "
            "r = o.gemini_read(sys.argv[1]); print(json.dumps({'result': 'none' if not r or r.get('none') else 'owner found', "
            "'owner': (r or {}).get('owner', ''), 'sources': (r or {}).get('sites', 0), 'usage': o.GEMINI_USAGE}))")
    env = {**os.environ, "GEMINI_API_KEY": key, "GEMINI_MODEL": model}
    out = subprocess.run([sys.executable, "-c", code, name], capture_output=True, text=True, env=env, timeout=180)
    lines = [l for l in (out.stdout + out.stderr).splitlines() if l.strip()]
    print(f"  owner check ({model}) on {name}: " + (lines[-1][:300] if lines else "no output"))


def main() -> None:
    found = [(n, os.environ.get(n, "").strip()) for n in NAMES]
    found = [(n, k) for n, k in found if k]
    print("Gemini key secrets set: " + (", ".join(n for n, _ in found) or "none of " + ", ".join(NAMES)))
    for name, key in found:
        check(name, key)
    # the new key, end to end: the owner check's own call on two public companies (their owners are on record)
    # Google's newer Interactions API (its 404 for gemini-2.5-flash recommends it): does Google Search run there?
    new = next(((n, k) for n, k in found if n != "GEMINI_API_KEY"), found[0] if found else None)
    if new:
        print(f"\nInteractions API with {new[0]}:")
        for company in ("CLOETTA UK LIMITED",):
            interactions(company, new[1], "gemini-3.8-flash")


def _walk(obj, seen: dict) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "type" and isinstance(v, str):
                seen.setdefault("types", []).append(v)
            elif k == "text" and isinstance(v, str):
                seen.setdefault("texts", []).append(v)
            elif k in ("url", "uri") and isinstance(v, str):
                seen.setdefault("urls", []).append(v)
            _walk(v, seen)
    elif isinstance(obj, list):
        for v in obj:
            _walk(v, seen)


def interactions(name: str, key: str, model: str) -> None:
    """One owner question through POST /v1beta/interactions with the google_search tool: did a search run (a
    google_search step, cited links) and what came back — field names and counts only, the answer's first words."""
    import sys
    sys.path.insert(0, ".")
    from sourcer import owner_search as o
    body = {"model": model, "input": SEARCH_FIRST + o._GEMINI_PROMPT.format(name=name, number="unknown"),
            "tools": [{"type": "google_search"}]}
    status, out, err = _call(f"{BASE}/interactions", key, body, timeout=150)
    print(f"  {name} ({model}):")
    if status != 200:
        print(f"    HTTP {status} {err}")
        return
    seen: dict = {}
    _walk(out, seen)
    types = list(dict.fromkeys(seen.get("types") or []))
    urls = [u for u in seen.get("urls") or [] if u.startswith("http")]
    print(f"    HTTP 200; top fields {sorted(out)}; step/part types {types}; links {len(urls)} "
          f"(e.g. {urls[0][:80] if urls else 'none'})")
    print(f"    answer: {' '.join(' '.join(seen.get('texts') or []).split())[:260]!r}")
    # where the sources sit: each step's type and field names, nested field names two levels down (no values but
    # strings that look like links or titles, cut short)
    for step in out.get("steps") or []:
        def fields(obj, depth=0):
            if depth > 3:
                return "…"
            if isinstance(obj, dict):
                return "{" + ", ".join(f"{k}: {fields(v, depth + 1)}" for k, v in list(obj.items())[:8]) + "}"
            if isinstance(obj, list):
                return f"[{len(obj)} × {fields(obj[0], depth + 1) if obj else ''}]"
            if isinstance(obj, str):
                return repr(obj[:60]) if re.match(r"https?://|[A-Z][\w ]{2,40}$", obj) else f"str({len(obj)})"
            return type(obj).__name__
        print(f"    step {step.get('type')}: {fields(step)[:700]}")


# Gemini 3.x answers well-known questions from memory even with Google Search on (25 Nov 2026: no search ran for
# Cloetta UK or Warburtons): told to search first, does it?
SEARCH_FIRST = ("Search Google before you answer - do not answer from memory, because ownership changes often. "
                "Base the answer only on what the search results say.\n\n")


def shape(name: str, key: str, model: str, lead: str = "", tool: str = "google_search") -> None:
    """What the grounded answer looks like on this model: the response's fields and the grounding metadata's shape
    (counts and field names, the answer's first words) — to fit the owner check's grounding rule to it."""
    import sys
    sys.path.insert(0, ".")
    from sourcer import owner_search as o
    body = {"contents": [{"parts": [{"text": lead + o._GEMINI_PROMPT.format(name=name, number="unknown")}]}],
            "tools": [{tool: {}}], "generationConfig": {"temperature": 0}}
    status, out, err = _call(f"{BASE}/models/{model}:generateContent", key, body)
    print(f"  {name} ({model}, tool {tool}{', told to search first' if lead else ''}):")
    if status != 200:
        print(f"    shape: HTTP {status} {err}")
        return
    cand = (out.get("candidates") or [{}])[0]
    meta = cand.get("groundingMetadata") or {}
    parts = (cand.get("content") or {}).get("parts") or []
    text = " ".join("".join(p.get("text", "") for p in parts).split())
    supports = meta.get("groundingSupports") or []
    print(f"    shape: candidate fields {sorted(cand)}; part fields {sorted({k for p in parts for k in p})}; "
          f"grounding fields {sorted(meta)}; chunks {len(meta.get('groundingChunks') or [])}, supports {len(supports)}, "
          f"queries {meta.get('webSearchQueries')}; support segment fields {sorted({k for s_ in supports for k in (s_.get('segment') or {})})}")
    print(f"    answer: {text[:260]!r}")


if __name__ == "__main__":
    main()
