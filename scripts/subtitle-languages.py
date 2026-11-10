#!/usr/bin/env python3
"""
Fetch every wanted subtitle language, not just the first one found.

Bazarr's language profile had English and Dutch with `cutoff` pointing at
English. Cutoff means "stop looking once you have this one", so every title
got an English subtitle and Bazarr declared itself finished - which is why
nothing in the library had Dutch subtitles unless the release shipped with
them embedded.

Set the cutoff to nothing and Bazarr keeps going until it has all of them, or
has genuinely failed to find them.

Languages come from SUBTITLE_LANGS in .env (e.g. en,nl,tr). Adding a language
does not retroactively fetch it: existing titles need a search for wanted
subtitles afterwards, which --search triggers.

Dry run by default. Pass --apply to write.
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import os
import urllib.request

HOMELAB_DIR = os.path.expanduser(os.environ.get('HOMELAB_DIR', '~/homelab'))
STATE_DIR = os.path.expanduser(os.environ.get('HOMELAB_STATE_DIR', '~/homelab-scripts'))


def setting(name, default=None):
    """From the environment, else the stack's .env, else the default."""
    value = os.environ.get(name)
    if not value:
        try:
            with open(os.path.join(HOMELAB_DIR, '.env')) as f:
                for line in f:
                    if line.startswith(f'{name}='):
                        value = line.split('=', 1)[1].strip().strip('"\'')
        except OSError:
            pass
    if value:
        return value
    if default is None:
        raise SystemExit(f'{name} is not set: add it to {HOMELAB_DIR}/.env')
    return default


HOST = setting('BAZARR_HOST', '127.0.0.1')  # Bazarr's port is published on the host
PORT = int(setting('BAZARR_PORT', '6767'))
CONFIG = '/config/config/config.yaml'

# Japanese is deliberately absent. For anime it ships embedded in the release
# rather than published separately - use_embedded_subs is on, so those tracks
# are already found - and asking for it externally spent a quarter of the
# throttle budget on searches that were never going to land.
# Two-letter codes, in order of preference, from SUBTITLE_LANGS in .env.
CODES = [c.strip() for c in setting('SUBTITLE_LANGS').split(',') if c.strip()]


def api_key():
    import subprocess
    out = subprocess.run(
        ['docker', 'exec', 'bazarr', 'sh', '-c', f'grep -m1 apikey {CONFIG}'],
        capture_output=True, text=True, timeout=20).stdout
    return out.split(':', 1)[1].strip().strip('"\'')


class Bazarr:
    def __init__(self, key, apply_):
        self.key, self.apply = key, apply_
        self.base = f'http://{HOST}:{PORT}/api'
        self.changed = 0

    def get(self, path):
        req = urllib.request.Request(self.base + path, headers={'X-API-KEY': self.key})
        raw = urllib.request.urlopen(req, timeout=25).read()
        return json.loads(raw) if raw else None

    def post_form(self, path, fields):
        body = urllib.parse.urlencode(fields).encode()
        req = urllib.request.Request(
            self.base + path, data=body, method='POST',
            headers={'X-API-KEY': self.key,
                     'Content-Type': 'application/x-www-form-urlencoded'})
        return urllib.request.urlopen(req, timeout=60).status

    def say(self, msg, change=True):
        print(f'  {"->" if change and self.apply else ("would" if change else "   ")} {msg}')
        if change:
            self.changed += 1


def wanted(b):
    """(code, name) pairs, named the way Bazarr names them."""
    try:
        names = {l.get('code2'): l.get('name') for l in b.get('/system/languages') or []}
    except urllib.error.HTTPError:
        names = {}
    return [(c, names.get(c) or c) for c in CODES]


def sync_profile(b):
    WANTED = wanted(b)
    PROFILE_NAME = ' + '.join(n for _, n in WANTED)
    profiles = b.get('/system/languages/profiles')
    target = next((p for p in profiles if p['profileId'] == 1), None)
    if target is None:
        b.say('no profile with id 1 to update', False)
        return

    # Item ids are positional within a profile and Bazarr renumbers from 1.
    items = [{
        'id': i,
        'language': code,
        'audio_exclude': 'False',
        'audio_only_include': 'False',
        'hi': 'False',
        'forced': 'False',
    } for i, (code, _) in enumerate(WANTED, start=1)]

    have = [i['language'] for i in target['items']]
    want = [c for c, _ in WANTED]

    if have == want and target['cutoff'] is None and target['name'] == PROFILE_NAME:
        b.say('language profile already correct', False)
        return

    if target['cutoff'] is not None:
        b.say(f'cutoff {target["cutoff"]} -> none  (stop giving up after the first hit)')
    if have != want:
        b.say(f'languages {have} -> {want}')
    if target['name'] != PROFILE_NAME:
        b.say(f'name "{target["name"]}" -> "{PROFILE_NAME}"')

    target['name'] = PROFILE_NAME
    target['items'] = items
    # None, not 0: Bazarr treats a cutoff of nothing as "collect them all".
    target['cutoff'] = None

    if b.apply:
        b.post_form('/system/settings',
                    {'languages-profiles': json.dumps(profiles)})


def report_coverage(b):
    """How many titles are on the profile, so the effect is visible."""
    for kind in ('series', 'movies'):
        try:
            data = b.get(f'/{kind}?length=-1').get('data', [])
        except urllib.error.HTTPError:
            continue
        on_one = sum(1 for x in data if x.get('profileId') == 1)
        print(f'     {kind}: {on_one} of {len(data)} on profile 1')


def search_wanted(b):
    """Ask Bazarr to go and find what the widened profile now wants.

    Adding a language does not backfill it - Bazarr only looks when something
    asks. Without this the change appears to do nothing until the next time a
    file is imported.
    """
    tasks = b.get('/system/tasks') or {}
    rows = tasks.get('data', tasks if isinstance(tasks, list) else [])
    wanted = [t for t in rows
              if 'wanted' in (t.get('name', '') + t.get('job_id', '')).lower()]
    if not wanted:
        print('     no "search wanted" task found - run it from the Bazarr UI')
        return
    for t in wanted:
        b.say(f'run task: {t.get("name")}')
        if b.apply:
            b.post_form('/system/tasks', {'taskid': t.get('job_id')})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--search', action='store_true',
                    help='also trigger a search for the newly wanted subtitles')
    args = ap.parse_args()

    try:
        b = Bazarr(api_key(), args.apply)
        print('== bazarr')
        sync_profile(b)
        report_coverage(b)
        if args.search:
            search_wanted(b)
    except urllib.error.HTTPError as e:
        sys.exit(f'{e.code}: {e.read().decode()[:200]}')

    print()
    print(f'{b.changed} change(s) ' + ('applied.' if args.apply
                                       else 'pending. Re-run with --apply to write them.'))


if __name__ == '__main__':
    main()
