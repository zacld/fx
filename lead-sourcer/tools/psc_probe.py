#!/usr/bin/env python3
"""
tools/psc_probe.py — what Companies House's free daily "people with significant control" snapshot looks like
(download.companieshouse.gov.uk/en_pscdata.html), before building on it: the files listed, their sizes, and the shape
of the records (keys, kinds, dates) in the first part. Read-only; prints structure and counts only — no names.
"""
from __future__ import annotations

import io
import json
import re
import sys
import urllib.request
import zipfile
from collections import Counter

PAGE = "https://download.companieshouse.gov.uk/en_pscdata.html"
UA = {"User-Agent": "fx-lead-sourcer/1.0 (+https://github.com/zacld/fx)"}


def get(url, limit=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read(limit) if limit else r.read()


def shape(obj, depth=0):
    if isinstance(obj, dict):
        return {k: shape(v, depth + 1) if depth < 3 else type(v).__name__ for k, v in obj.items()}
    if isinstance(obj, list):
        return [shape(obj[0], depth + 1)] if obj else []
    return type(obj).__name__


page = get(PAGE).decode("utf-8", "replace")
links = list(dict.fromkeys(re.findall(r'href="([^"]+\.zip)"', page)))
print(f"{len(links)} zip links on the page; first and last: {links[:2]} … {links[-2:]}")
first = links[0] if links[0].startswith("http") else "https://download.companieshouse.gov.uk/" + links[0].lstrip("/")
head = urllib.request.urlopen(urllib.request.Request(first, headers=UA, method="HEAD"), timeout=60)
print(f"first part: {first.rsplit('/', 1)[-1]} — {int(head.headers.get('content-length') or 0) / 1e6:.0f} MB")
data = get(first)
zf = zipfile.ZipFile(io.BytesIO(data))
print("members:", [(i.filename, round(i.file_size / 1e6)) for i in zf.infolist()][:5])
kinds, corp_id_keys, dated = Counter(), Counter(), Counter()
shown = 0
with zf.open(zf.infolist()[0]) as f:
    for n, line in enumerate(io.TextIOWrapper(f, encoding="utf-8")):
        if n >= 200000:
            break
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        d = rec.get("data") or {}
        kinds[d.get("kind", "?")] += 1
        if "corporate" in str(d.get("kind")):
            corp_id_keys.update((d.get("identification") or {}).keys())
            dated["notified_on" in d] += 0
            dated["has ceased_on" if d.get("ceased_on") else "current"] += 1
            if shown < 2:
                print("corporate record shape:", json.dumps({"top": shape({k: v for k, v in rec.items() if k != "data"}),
                                                              "data": shape(d)})[:1500])
                print("  sample dates:", d.get("notified_on"), "| ceased:", d.get("ceased_on"),
                      "| country:", (d.get("identification") or {}).get("country_registered"),
                      "| place:", (d.get("identification") or {}).get("place_registered"))
                shown += 1
print(f"records read: {n + 1}; kinds: {dict(kinds.most_common())}")
print(f"corporate identification keys: {dict(corp_id_keys)}; status: {dict(dated)}")
