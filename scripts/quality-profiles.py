#!/usr/bin/env python3
"""
The quality profiles the app offers, and nothing else.

Radarr and Sonarr ship six or seven stock profiles, of which this library used
two. The rest were noise - and once the app grew a quality picker they stopped
being harmless noise and became options someone could pick by mistake.

Five, named for the LOWEST quality each will accept:

    HD 1080p   1080p only                     the default
    HD         720p and up
    DVD        DVD and up
    SD         SDTV and up
    CAM        anything, absolute last resort

That is a floor, never a ceiling. Radarr and Sonarr always grab the best
release a profile permits, so picking "CAM" still gets a 1080p file when one
exists - it simply will not refuse a camrip when nothing else is there. Every
one of them tops out at 1080p and upgrades toward it, so a low pick is a
placeholder that gets replaced rather than a decision you are stuck with.

No 4K. It cannot be scoped per user - Jellyfin serves one file per title to
everyone - and this server has no HEVC hardware decoder, so any 4K that fails
to direct-play falls to software decoding on a 2012 CPU.

Dry run by default. Pass --apply to write.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HOST = os.environ.get('ARR_HOST', '192.168.68.59')
ENV = os.path.expanduser('~/homelab/.env')

# Named tiers rather than a slice of the app's own ordering.
#
# Radarr and Sonarr disagree about ranking - Sonarr puts Bluray-720p and
# WEB 720p *above* HDTV-1080p, which is a defensible opinion about which looks
# better and a terrible basis for a menu item called "HD 1080p". Listing the
# qualities by name makes the five mean the same thing in both apps.
#
# Anything absent from a given install is skipped, which is how Sonarr - with
# no CAM, TELESYNC or TELECINE - simply ends up without those rungs.
T_1080 = ['HDTV-1080p', 'WEB 1080p', 'WEBDL-1080p', 'WEBRip-1080p',
          'Bluray-1080p', 'Remux-1080p']
T_720 = ['HDTV-720p', 'WEB 720p', 'WEBDL-720p', 'WEBRip-720p', 'Bluray-720p']
T_DVD = ['WEB 480p', 'WEBDL-480p', 'WEBRip-480p', 'Bluray-480p', 'Bluray-576p',
         'DVD', 'DVD-R']
T_SD = ['SDTV']
T_CAM = ['CAM', 'TELESYNC', 'TELECINE', 'DVDSCR']

# Cumulative: each is the one above it plus one more rung down, because these
# are floors. "CAM" still takes a 1080p release when one exists.
PROFILES = [
    ('HD 1080p', T_1080),
    ('HD', T_1080 + T_720),
    ('DVD', T_1080 + T_720 + T_DVD),
    ('SD', T_1080 + T_720 + T_DVD + T_SD),
    ('CAM', T_1080 + T_720 + T_DVD + T_SD + T_CAM),
]

# 2160p, BR-DISK and Raw-HD are deliberately in none of them: 4K cannot be
# scoped per user - Jellyfin serves one file per title to everyone - and this
# server has no HEVC hardware decoder. WORKPRINT is an unfinished edit.
CUTOFF = 'WEB 1080p'

# Where the titles on the old stock profiles should land.
#
# "Any" is deliberately absent: it stays, by request. Note it allows everything
# up to BR-DISK and Remux-2160p in Radarr, so a *new* movie placed on it can
# grab an 80GB disc image this server cannot transcode. Everything on it today
# is already 1080p.
# Mapped to the nearest equivalent, never to something stricter. The old
# Radarr default is literally named "720p fallback" and the Sonarr one allows
# 720p too, so both become "HD" - moving them to "HD 1080p" would quietly make
# 32 titles pickier than they are today, and a film with only a 720p release
# would stop being findable with nothing to show why.
#
# Change these to "HD 1080p" if you would rather tighten them; it is one edit
# and the dry run will list every title it touches.
MIGRATIONS = {
    'HD-1080p (720p fallback)': 'HD',
    'HD-1080p': 'HD',
    'Archive (DVD to 1080p)': 'CAM',
}


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

    def call(self, path, body=None, method=None):
        sep = '&' if '?' in path else '?'
        req = urllib.request.Request(
            f'http://{HOST}:{self.port}/api/v3/{path}{sep}apikey={self.key}',
            data=json.dumps(body).encode() if body is not None else None,
            method=method or ('POST' if body is not None else 'GET'),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
        return json.loads(raw) if raw else None

    def say(self, msg, change=True):
        print(f'  {"->" if change and self.apply else ("would" if change else "   ")} {msg}')
        if change:
            self.changed += 1


def name_of(node):
    return (node.get('quality') or {}).get('name') or node.get('name')


def build(template, label, wanted):
    """One profile allowing exactly the named qualities.

    Cloned from an existing profile so every quality id and group is exactly as
    this install defines them; building the tree by hand invites an id that
    does not match. Only top-level entries are flipped - a group carries the
    flag for the qualities inside it.
    """
    p = json.loads(json.dumps(template))
    p.pop('id', None)
    p['name'] = label
    p['upgradeAllowed'] = True
    p['minFormatScore'] = 0

    want = set(wanted)
    for node in p['items']:
        node['allowed'] = name_of(node) in want

    allowed = [n for n in p['items'] if n['allowed']]
    if not allowed:
        return None

    cut = next((n for n in allowed if name_of(n) == CUTOFF), allowed[-1])
    p['cutoff'] = cut.get('id') or (cut.get('quality') or {}).get('id')
    return p


def sync(a):
    existing = {p['name']: p for p in a.call('qualityprofile')}
    # The widest one has every quality and group this install knows about.
    template = max(existing.values(), key=lambda p: len(p['items']))

    previous = None
    for label, qualities in PROFILES:
        want = build(template, label, qualities)
        if want is None:
            a.say(f'cannot build "{label}": no matching qualities here', False)
            continue

        allowed = [name_of(n) for n in want['items'] if n['allowed']]

        # Sonarr has no CAM, TELESYNC or TELECINE, so its "CAM" comes out
        # identical to its "SD". Two menu entries that do the same thing is
        # worse than one, so the narrower name wins and this one is skipped.
        if allowed == previous:
            a.say(f'"{label}" would duplicate the profile above it here, skipped', False)
            continue
        previous = allowed

        if label in existing:
            have = [name_of(n) for n in existing[label]['items'] if n.get('allowed')]
            if have == allowed:
                a.say(f'"{label}" already correct', False)
                continue
            a.say(f'update "{label}": {" > ".join(reversed(allowed))}')
            if a.apply:
                want['id'] = existing[label]['id']
                a.call(f'qualityprofile/{want["id"]}', want, 'PUT')
        else:
            a.say(f'create "{label}": {" > ".join(reversed(allowed))}')
            if a.apply:
                a.call('qualityprofile', want)


def migrate(a):
    """Move titles off the old stock profiles onto the new five.

    Done after the five exist, by name, because their ids are only known once
    they have been created.
    """
    profiles = {p['name']: p['id'] for p in a.call('qualityprofile')}
    by_id = {v: k for k, v in profiles.items()}
    endpoint = 'movie' if a.name == 'radarr' else 'series'

    for item in a.call(endpoint):
        old = by_id.get(item['qualityProfileId'])
        target = MIGRATIONS.get(old)
        if not target:
            continue
        # On a dry run the destination has not been created yet, so it is not
        # in `profiles`. Report the move anyway - a dry run that silently
        # omits half the work is worse than no dry run at all.
        if target not in profiles:
            a.say(f'{item["title"][:34]}: "{old}" -> "{target}" (once created)')
            continue
        a.say(f'{item["title"][:34]}: "{old}" -> "{target}"')
        if a.apply:
            item['qualityProfileId'] = profiles[target]
            a.call(f'{endpoint}/{item["id"]}', item, 'PUT')


# Kept whatever happens. Its titles were left in place by choice, and it is
# not this script's business to move them.
PROTECTED = {'Any'}


def migrate_collections(a):
    """Repoint Radarr collections, which also pin a quality profile.

    Radarr creates a collection for every film that belongs to a TMDB one, and
    each carries its own qualityProfileId. They are all unmonitored here and do
    nothing - but a profile a collection points at cannot be deleted, which is
    how "QualityProfile [4] is in use" appears with no movie on it.
    """
    if a.name != 'radarr':
        return
    profiles = {p['name']: p['id'] for p in a.call('qualityprofile')}
    by_id = {v: k for k, v in profiles.items()}

    for c in a.call('collection'):
        old = by_id.get(c.get('qualityProfileId'))
        target = MIGRATIONS.get(old)
        if not target or target not in profiles:
            continue
        a.say(f'collection {c.get("title", "?")[:30]}: "{old}" -> "{target}"')
        if a.apply:
            c['qualityProfileId'] = profiles[target]
            a.call(f'collection/{c["id"]}', c, 'PUT')


def report_unused(a, keep, prune=False):
    """What is left over, and whether anything still points at it.

    Deletes only with --prune, and only a profile nothing points at. A profile
    with titles on it is a decision rather than a cleanup, so it is reported
    and left exactly where it is.
    """
    endpoint = 'movie' if a.name == 'radarr' else 'series'
    used = {}
    for item in a.call(endpoint):
        used[item['qualityProfileId']] = used.get(item['qualityProfileId'], 0) + 1
    for p in a.call('qualityprofile'):
        if p['name'] in keep or p['name'] in PROTECTED:
            continue
        n = used.get(p['id'], 0)
        if n:
            print(f'     leftover: "{p["name"]}" id={p["id"]} used by {n}'
                  '  <- move these first, not deleted')
            continue
        if not prune:
            print(f'     leftover: "{p["name"]}" id={p["id"]} unused'
                  '  <- pass --prune to delete')
            continue
        a.say(f'delete unused profile "{p["name"]}"')
        if not a.apply:
            continue
        try:
            a.call(f'qualityprofile/{p["id"]}', method='DELETE')
        except urllib.error.HTTPError as e:
            # Something outside the movie list still points at it - a
            # collection, usually. Reported and stepped over, because one
            # blocked profile aborting the loop leaves the rest behind.
            detail = e.read().decode()
            msg = 'in use' if 'in use' in detail else f'{e.code}'
            print(f'        kept: "{p["name"]}" could not be deleted ({msg})')
            a.changed -= 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--prune', action='store_true',
                    help='delete leftover profiles nothing points at')
    args = ap.parse_args()

    keys = load_keys()
    total = 0
    keep = {label for label, _ in PROFILES}
    for name, port, key in (('radarr', 7878, keys.get('RADARR_API_KEY')),
                            ('sonarr', 8989, keys.get('SONARR_API_KEY'))):
        if not key:
            print(f'== {name}: no API key, skipped')
            continue
        print(f'== {name}')
        a = Arr(name, port, key, args.apply)
        try:
            sync(a)
            migrate(a)
            migrate_collections(a)
            report_unused(a, keep, args.prune)
        except urllib.error.HTTPError as e:
            print(f'  !! {e.code}: {e.read().decode()[:200]}')
        total += a.changed

    print()
    print(f'{total} change(s) ' + ('applied.' if args.apply
                                   else 'pending. Re-run with --apply to write them.'))


if __name__ == '__main__':
    main()
