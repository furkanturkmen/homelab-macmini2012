#!/usr/bin/env python3
"""
Apply the rules in docs/release-rules.md to Radarr and Sonarr.

Dry run by default - it prints what it would change and touches nothing. Pass
--apply to write.

Idempotent: every step checks the current value first, so running it twice is
the same as running it once, and running it after a manual change in the UI
reports that change rather than fighting it.

Reads the API keys from ~/homelab/.env, which is gitignored. Nothing here takes
a key on the command line, where it would land in shell history.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HOST = os.environ.get('ARR_HOST', '192.168.68.59')
ENV = os.path.expanduser('~/homelab/.env')

# R8 and R9 used to live here - which qualities each profile allows, and the
# archive profile reaching furthest down. They moved to quality-profiles.py,
# which owns profile *membership* and which title uses which profile.
#
# They cannot both own it. Left here, this script re-added DVD rungs to
# "HD 1080p" and recreated a profile the other had just pruned, because it
# keyed off upgradeAllowed and the new profiles all have it.
#
# This script owns scoring: propers, custom formats, minimum score, metadata.


def load_keys():
    keys = {}
    try:
        with open(ENV) as f:
            for line in f:
                line = line.strip()
                if line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                keys[k.strip()] = v.strip().strip('"').strip("'")
    except OSError as e:
        sys.exit(f'cannot read {ENV}: {e}')
    return keys


class Arr:
    def __init__(self, name, port, key, apply_):
        self.name, self.port, self.key, self.apply = name, port, key, apply_
        self.changed = 0

    def url(self, path):
        sep = '&' if '?' in path else '?'
        return f'http://{HOST}:{self.port}/api/v3/{path}{sep}apikey={self.key}'

    def get(self, path):
        with urllib.request.urlopen(self.url(path), timeout=30) as r:
            return json.load(r)

    def write(self, path, body, method):
        req = urllib.request.Request(
            self.url(path), data=json.dumps(body).encode(),
            method=method, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
        return json.loads(raw) if raw else None

    def say(self, msg, will_change=True):
        if not will_change:
            mark = '   '
        else:
            mark = '->' if self.apply else 'would'
        print(f'  {mark} {msg}')
        if will_change:
            self.changed += 1


def ensure_propers(a):
    """R0 - stop revision outranking score."""
    cfg = a.get('config/mediamanagement')
    if cfg.get('downloadPropersAndRepacks') == 'doNotPrefer':
        a.say('propers already doNotPrefer', False)
        return
    a.say(f"propers {cfg.get('downloadPropersAndRepacks')} -> doNotPrefer")
    if a.apply:
        cfg['downloadPropersAndRepacks'] = 'doNotPrefer'
        a.write('config/mediamanagement', cfg, 'PUT')


def ensure_format(a, name, regex):
    """R0b and R7 - a custom format exists.

    The shape is copied from the formats already in Sonarr, so these sit
    alongside them rather than looking foreign in the UI.
    """
    if name in {c['name'] for c in a.get('customformat')}:
        a.say(f'custom format "{name}" exists', False)
        return
    a.say(f'create custom format "{name}"  {regex}')
    if not a.apply:
        return
    a.write('customformat', {
        'name': name,
        'includeCustomFormatWhenRenaming': False,
        'specifications': [{
            'name': name,
            'implementation': 'ReleaseTitleSpecification',
            'negate': False,
            'required': True,
            'fields': [{'name': 'value', 'value': regex}],
        }],
    }, 'POST')


# Per-profile score overrides. Empty now: R11 existed for Ultra-HD, which was
# retired along with 4K - it cannot be scoped per user and this server has no
# HEVC decoder. Kept because the mechanism is sound if a profile ever needs a
# score that differs from the rest.
PROFILE_OVERRIDES = {}


def ensure_profiles(a, scores):
    """R1 - reject negatives; and score the named formats in every profile."""
    for p in a.get('qualityprofile'):
        dirty = False
        label = f'profile "{p["name"]}"'
        over = PROFILE_OVERRIDES.get(p['name'], {})
        # A separate name, not a rebinding of `scores`. Assigning to the
        # parameter carried Ultra-HD's override into every profile processed
        # after it - the dry run showed HD - 720p/1080p and Archive picking up
        # a change meant for one profile.
        effective = {**scores, **over.get('scores', {})}

        if 'upgradeAllowed' in over and p.get('upgradeAllowed') != over['upgradeAllowed']:
            a.say(f'{label}: upgradeAllowed {p.get("upgradeAllowed")} -> {over["upgradeAllowed"]}')
            p['upgradeAllowed'] = over['upgradeAllowed']
            dirty = True

        if p.get('minFormatScore') != 0:
            a.say(f'{label}: minFormatScore {p.get("minFormatScore")} -> 0')
            p['minFormatScore'] = 0
            dirty = True

        for item in p.get('formatItems', []):
            want = effective.get(item['name'])
            if want is not None and item.get('score') != want:
                a.say(f'{label}: "{item["name"]}" {item.get("score")} -> {want}')
                item['score'] = want
                dirty = True

        if not dirty:
            a.say(f'{label}: already correct', False)
        elif a.apply:
            a.write(f'qualityprofile/{p["id"]}', p, 'PUT')


def ensure_metadata(a):
    """R10 - write an NFO next to every file, so Jellyfin never has to guess.

    Radarr imported Fall (2022) correctly and Jellyseerr still reported it as
    processing, because Jellyfin had not identified the file against TMDB yet -
    no provider ids, no artwork - and Jellyseerr matches on TMDB id alone. The
    film existed on disk and the request looked unfulfilled.

    With no metadata provider enabled there is no .nfo, so Jellyfin has only
    the filename to go on. That usually works and silently sometimes does not,
    which is the worst of both.

    XbmcMetadata is the one Jellyfin reads. Enabling it costs a small .nfo and
    some artwork beside each file.
    """
    for m in a.get('metadata'):
        if m.get('implementation') != 'XbmcMetadata':
            continue
        if m.get('enable'):
            a.say(f'metadata "{m["name"]}" already enabled', False)
            return
        a.say(f'enable metadata "{m["name"]}" - writes .nfo with the TMDB id')
        if a.apply:
            m['enable'] = True
            a.write(f'metadata/{m["id"]}', m, 'PUT')
        return
    a.say('no XbmcMetadata provider found', False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='write changes')
    args = ap.parse_args()

    keys = load_keys()
    total = 0
    for name, port, key in (('radarr', 7878, keys.get('RADARR_API_KEY')),
                            ('sonarr', 8989, keys.get('SONARR_API_KEY'))):
        if not key:
            print(f'== {name}: no API key in {ENV}, skipped')
            continue
        print(f'== {name}')
        a = Arr(name, port, key, args.apply)
        try:
            ensure_propers(a)
            ensure_format(a, 'Repack/Proper', r'\b(PROPER|REPACK)\b')
            if name == 'radarr':
                ensure_format(a, 'Italian release', r'\b(ITA|ITALIAN)\b')
            ensure_profiles(a, {'Repack/Proper': 5, 'Italian release': -1000,
                                'HEVC (x265)': -20, 'AV1': -25})
            ensure_metadata(a)
        except urllib.error.HTTPError as e:
            print(f'  !! {name} {e.code}: {e.read().decode()[:200]}')
        total += a.changed

    print()
    tail = 'applied.' if args.apply else 'pending. Re-run with --apply to write them.'
    print(f'{total} change(s) {tail}')


if __name__ == '__main__':
    main()
