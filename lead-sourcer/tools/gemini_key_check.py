"""
tools/gemini_key_check.py — does a Gemini API key work, and does the owner check work with it? (Zac, 25 Nov 2026: a new
key added as a second secret.)

For each Gemini key secret that is set (the workflow passes every likely name), read-only and never printing the key:
  1. lists the models the key can use (the newest Flash / Pro names, the -latest aliases);
  2. with the newer key (else the first), runs the owner check's own call (sourcer/owner_search.gemini_read: Gemini 3
     through the Interactions API, Google Search, the owner found on the page it cites) on two public companies whose
     owners are on record — the owner, its source site, the searches and tokens it took.
Errors print their status and a short message with digits masked (no project numbers in a public log); an owner who is
a person prints as "a person". Standard library only. Workflow "Gemini key check" (on a push of this file or its
workflow, or by hand; a re-run isn't open to the coding agent, so a check is re-run by pushing a change here).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

NAMES = ["GEMINI_KEY_2", "GEMINI_KEY2", "GEMINI_API_KEY_2", "GEMINI_API_KEY2", "GEMINI_2", "GEMINIKEY2", "GEMINI_API_2",
         "GEMINI_NEW", "GEMINI_API_KEY"]
BASE = "https://generativelanguage.googleapis.com/v1beta"
COMPANIES = ("CLOETTA UK LIMITED", "BRITISH BAKELS LIMITED")


def _call(url: str, key: str, timeout: int = 60) -> tuple[int, dict, str]:
    req = urllib.request.Request(url, headers={"x-goog-api-key": key})
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


def check(name: str, key: str) -> bool:
    print(f"\n{name}: set")
    status, data, err = _call(f"{BASE}/models?pageSize=1000", key)
    if status != 200:
        print(f"  models: HTTP {status} {err}")
        return False
    models = [m["name"].split("/")[-1] for m in data.get("models") or []
              if "generateContent" in (m.get("supportedGenerationMethods") or [])]
    flash = sorted((m for m in models if re.fullmatch(r"gemini-[\d.]+-flash(-preview)?(-\d\d-\d{4})?", m)), key=_version, reverse=True)
    aliases = [m for m in models if m.endswith("-latest")]
    pro = sorted((m for m in models if re.fullmatch(r"gemini-[\d.]+-pro(-preview)?(-\d\d-\d{4})?", m)), key=_version, reverse=True)
    print(f"  models: HTTP 200, {len(models)} usable; newest Flash: {', '.join(flash[:3]) or 'none'}; "
          f"newest Pro: {', '.join(pro[:2]) or 'none'}; aliases: {', '.join(aliases) or 'none'}")
    return True


# run in a fresh process so the key and the model choice stay local; the raw reply's usage field names are printed (not
# its values' text) so the owner check's token count can follow them
_LOOKUP = """
import json, sys
sys.path.insert(0, '.')
from sourcer import owner_search as o
shape = {}
real = o._gemini
def spy(prompt, key):
    out = real(prompt, key)
    if out:
        shape['usage'] = sorted((out.get('usage') or out.get('usageMetadata') or {}).keys())
        shape['steps'] = [s.get('type') for s in out.get('steps') or []]
    return out
o._gemini = spy
r = o.gemini_read(sys.argv[1]) or {}
person = r.get('kind') == 'person'
import re, urllib.parse
for owner, kind in o.GEMINI_LAST.get('chain') or []:
    print('chain step:', 'a person' if kind == 'person' else owner, f'({kind})')
for url, why, quote in o.GEMINI_LAST.get('checks') or []:
    host = urllib.parse.urlsplit(url).netloc if url else 'none'
    social = any(x in url.lower() for x in ('linkedin.', 'facebook.', 'twitter.', 'x.com', 'instagram.'))
    path = '' if social else urllib.parse.urlsplit(url).path[:70]
    print(f'cited page: {host}{path} -> {why}; quote {len(quote)} chars' + ('' if social else f': {quote[:140]!r}'))
print(json.dumps({'result': 'owner found' if r.get('owner') else ('nothing backed it' if r.get('unchecked') else 'none'),
                  'owner': 'a person' if person else r.get('owner', ''), 'kind': r.get('kind', ''),
                  'country': r.get('country', ''), 'source': r.get('source', ''),
                  'chain': ['a person' if c.get('kind') == 'person' else c.get('owner') for c in r.get('chain') or []],
                  'model': (o._gemini_model or [''])[0], 'usage': o.GEMINI_USAGE, 'reply': shape}))
"""


def owner_lookup(name: str, key: str) -> None:
    env = {**os.environ, "GEMINI_API_KEY": key}
    try:
        out = subprocess.run([sys.executable, "-c", _LOOKUP, name], capture_output=True, text=True, env=env, timeout=400)
    except subprocess.TimeoutExpired:
        print(f"  owner check on {name}: no answer in 400 s")
        return
    lines = [l for l in (out.stdout + out.stderr).splitlines() if l.strip()]
    for line in lines[:-1]:
        print(f"    {line[:300]}")
    print(f"  owner check on {name}: " + (lines[-1][:600] if lines else "no output"))


def main() -> None:
    found = [(n, os.environ.get(n, "").strip()) for n in NAMES]
    found = [(n, k) for n, k in found if k]
    print("Gemini key secrets set: " + (", ".join(n for n, _ in found) or "none of " + ", ".join(NAMES)))
    working = [(n, k) for n, k in found if check(n, k)]
    new = next(((n, k) for n, k in working if n != "GEMINI_API_KEY"), working[0] if working else None)
    if not new:
        print("\nNo working key: the owner check can't be tried")
        return
    print(f"\nThe owner check (sourcer/owner_search.gemini_read) with {new[0]}:")
    for company in COMPANIES:
        owner_lookup(company, new[1])


if __name__ == "__main__":
    main()
