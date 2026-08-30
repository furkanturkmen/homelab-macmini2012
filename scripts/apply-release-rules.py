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

# R8. Everything from a DVD upward, including the Bluray rips the main profile
# does not carry. For titles nothing else can satisfy, assigned by hand.
#
# No camrip. A DVD only exists for a film old enough to have shipped on one, so
# it can never pre-empt a new release; a camrip appears exactly while a film is
# in cinemas, which is when grabbing one is worst. It is also a favourite
# malware wrapper - the only defence that actually covers that is
# torrent-guard.py opening the torrent and looking inside.
ARCHIVE_ALLOW = {
    'DVDSCR', 'SDTV', 'DVD', 'DVD-R', 'Bluray-480p', 'Bluray-576p',
    'HDTV-720p', 'WEB 720p', 'Bluray-720p', 'WEBDL-720p', 'WEBRip-720p',
    'HDTV-1080p', 'WEB 1080p', 'Bluray-1080p', 'WEBDL-1080p', 'WEBRip-1080p',
}
# Named only so the doc and the code agree on what is being kept out. The code
# denies by default, so this list is documentation rather than logic.
ARCHIVE_DENY = {'WORKPRINT', 'CAM', 'TELESYNC', 'TELECINE', 'REGIONAL', 'Unknown'}


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


def ensure_profiles(a, scores):
    """R1 - reject negatives; and score the named formats in every profile."""
    for p in a.get('qualityprofile'):
        dirty = False
        label = f'profile "{p["name"]}"'

        if p.get('minFormatScore') != 0:
            a.say(f'{label}: minFormatScore {p.get("minFormatScore")} -> 0')
            p['minFormatScore'] = 0
            dirty = True

        for item in p.get('formatItems', []):
            want = scores.get(item['name'])
            if want is not None and item.get('score') != want:
                a.say(f'{label}: "{item["name"]}" {item.get("score")} -> {want}')
                item['score'] = want
                dirty = True

        if not dirty:
            a.say(f'{label}: already correct', False)
        elif a.apply:
            a.write(f'qualityprofile/{p["id"]}', p, 'PUT')


# R9. The rungs below 720p that an upgrading profile may fall back to.
#
# Deliberately no CAM. A DVD only exists for a film old enough to have shipped
# on one, so it can never pre-empt a new release - whereas a camrip appears
# exactly while a film is in cinemas, which is when grabbing one is worst. CAM
# lives in the archive profile, assigned by hand.
FALLBACK_RUNGS = ['DVDSCR', 'SDTV', 'DVD', 'DVD-R']


def ensure_fallback_rungs(a):
    """R9 - let a profile that upgrades reach below its floor.

    Bin Roye (2015) is on a profile allowing nothing under 720p, and the only
    releases that exist are DVDRips. It searched forever and reported progress
    forever.

    Applied only where upgradeAllowed is already true. That is the whole safety
    argument: a DVD grabbed under such a profile is a placeholder that Radarr
    replaces the moment something better appears. On a profile that never
    upgrades the same change would make a DVDRip permanent.
    """
    for p in a.get('qualityprofile'):
        if not p.get('upgradeAllowed'):
            continue
        added = []
        for node in p['items']:
            n = (node.get('quality') or {}).get('name') or node.get('name')
            if n in FALLBACK_RUNGS and not node.get('allowed'):
                node['allowed'] = True
                added.append(n)
        if not added:
            a.say(f'profile "{p["name"]}": fallback rungs already allowed', False)
            continue
        a.say(f'profile "{p["name"]}": allow {", ".join(added)} as fallback')
        if a.apply:
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


def ensure_archive_profile(a):
    """R8 - one profile reaching down to DVD and across to the Bluray rips the
    main profile does not carry. Radarr takes the best allowed quality that
    exists, so the low rungs are only reached when nothing is above them, and
    cutoff plus upgradeAllowed replaces them when something appears."""
    profiles = a.get('qualityprofile')
    name = 'Archive (DVD to 1080p)'
    if any(p['name'] == name for p in profiles):
        a.say(f'profile "{name}" exists', False)
        return

    # Cloned from the widest existing profile so every quality id and group
    # stays exactly as this install defines them - building the tree by hand
    # invites an id that does not match.
    base = max(profiles, key=lambda p: len(p['items']))
    p = json.loads(json.dumps(base))
    p.pop('id', None)
    p['name'] = name
    p['upgradeAllowed'] = True
    p['minFormatScore'] = 0

    # Deny by default, then enable exactly what is wanted. Inheriting the
    # clone's flags is how 2160p, Remux and BR-DISK end up in an archive
    # profile: they were allowed in the profile it was copied from and nothing
    # here mentions them either way.
    #
    # Only the top level is set. A group ("WEB 1080p") carries the flag for the
    # qualities inside it, so touching its children changes nothing and risks
    # disagreeing with the group.
    for node in p['items']:
        n = (node.get('quality') or {}).get('name') or node.get('name')
        node['allowed'] = n in ARCHIVE_ALLOW

    # Radarr stores items worst-first and grabs the *highest* allowed quality
    # that exists, so printing them in stored order reads exactly backwards -
    # it puts CAM at the front and looks like CAM is preferred. Reversed here,
    # best first, with the last rung named as what it is.
    allowed = [n for n in ((x.get('quality') or {}).get('name') or x.get('name')
                           for x in p['items']) if n in ARCHIVE_ALLOW]
    if not allowed:
        a.say(f'cannot build "{name}": no quality names matched this install', False)
        return
    preference = ' > '.join(reversed(allowed))

    # Cloned from a profile whose cutoff may be a quality this one forbids,
    # which Radarr rejects. Aim at 1080p web, falling back to the best allowed.
    cutoff = next((x for x in p['items']
                   if ((x.get('quality') or {}).get('name') or x.get('name')) == 'WEB 1080p'
                   and x.get('allowed')), None)
    cutoff = cutoff or [x for x in p['items'] if x.get('allowed')][-1]
    p['cutoff'] = cutoff.get('id') or (cutoff.get('quality') or {}).get('id')

    a.say(f'create profile "{name}"')
    print(f'     best first: {preference}')
    print(f'     {allowed[0]} is the floor - only taken when nothing '
          f'above it exists, and replaced once something does')
    if a.apply:
        new = a.write('qualityprofile', p, 'POST')
        print(f'     id={new["id"]} - assign it to regional and pre-2010 titles')


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
            ensure_profiles(a, {'Repack/Proper': 5, 'Italian release': -1000})
            ensure_fallback_rungs(a)
            ensure_metadata(a)
            if name == 'radarr':
                ensure_archive_profile(a)
        except urllib.error.HTTPError as e:
            print(f'  !! {name} {e.code}: {e.read().decode()[:200]}')
        total += a.changed

    print()
    tail = 'applied.' if args.apply else 'pending. Re-run with --apply to write them.'
    print(f'{total} change(s) {tail}')


if __name__ == '__main__':
    main()
