#!/usr/bin/env python3
"""Stop refusing releases that are fine: efficient encodes, and x265 in Radarr.

Two rules were costing downloads, both found by tallying real rejection
reasons rather than by reading the config:

1. Sonarr's quality definitions carry a **minimum** size of 3-4 MB per minute.
   A modern HEVC season pack is legitimately smaller than that - one real
   rejection was "2.8 GB is smaller than minimum allowed 3.2 GB (for 30x
   819min)". The rule fires hardest on the most efficient encodes, which are
   the ones worth having. A size floor is also a poor forgery check: it reads
   a number the uploader chose. `torrent-guard.py` opens the torrent and looks
   inside, which is the check that actually works (R5).

2. Radarr refused HEVC and AV1 outright (`minFormatScore: 0`) while Sonarr
   ranked them last but took them (-25). Same library, same hardware, opposite
   answers - and a film existing only in x265 silently never downloaded. R7
   says the two apps must agree.

Dry run unless --apply.
"""
import json
import re
import subprocess
import sys
import urllib.request

APPLY = "--apply" in sys.argv
APPS = {"sonarr": 8989, "radarr": 7878}
MIN_FORMAT_SCORE = -25


def client(app):
    cfg = subprocess.run(["docker", "exec", app, "cat", "/config/config.xml"],
                         capture_output=True, text=True, check=True).stdout
    key = re.search(r"<ApiKey>([^<]+)</ApiKey>", cfg).group(1)
    base = f"http://192.168.68.59:{APPS[app]}/api/v3"

    def call(path, payload=None, method=None):
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {"X-Api-Key": key}
        if data:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(base + path, data=data, headers=headers,
                                     method=method or ("POST" if data else "GET"))
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
            return json.loads(body) if body else None
    return call


print("=== 1. size floors ===")
for app in APPS:
    call = client(app)
    changed = 0
    for d in call("/qualitydefinition"):
        if not d.get("minSize"):
            continue
        name = d["quality"]["name"]
        if not APPLY:
            print(f"  would clear {app} {name}: minSize {d['minSize']} -> 0")
            changed += 1
            continue
        d["minSize"] = 0
        call(f"/qualitydefinition/{d['id']}", d, method="PUT")
        print(f"  {app} {name}: minSize -> 0")
        changed += 1
    if not changed:
        print(f"  {app}: no size floors set, nothing to do")

print("\n=== 2. minFormatScore, so both apps agree ===")
for app in APPS:
    call = client(app)
    for p in call("/qualityprofile"):
        if p.get("minFormatScore") == MIN_FORMAT_SCORE:
            print(f'  {app} "{p["name"]}": already {MIN_FORMAT_SCORE}')
            continue
        if not APPLY:
            print(f'  would set {app} "{p["name"]}": '
                  f'minFormatScore {p.get("minFormatScore")} -> {MIN_FORMAT_SCORE}')
            continue
        old = p.get("minFormatScore")
        p["minFormatScore"] = MIN_FORMAT_SCORE
        call(f'/qualityprofile/{p["id"]}', p, method="PUT")
        print(f'  {app} "{p["name"]}": minFormatScore {old} -> {MIN_FORMAT_SCORE}')

if not APPLY:
    print("\ndry run. re-run with --apply to write.")
