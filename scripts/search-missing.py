#!/usr/bin/env python3
"""
Search for things that are monitored, missing, and that nothing will ever look
for on its own.

Radarr's only search task is RssSync, every 30 minutes, and RSS carries
newly *published* releases. A film from 2015 had its releases posted years ago
and will never appear in one - so a back-catalogue title sits monitored and
missing forever, reporting "searching" and doing nothing. There is no
"search for missing" scheduled task to fall back on.

Dry run by default: it lists what it would search and asks nothing of the
indexers. Pass --apply to actually trigger the searches.

Reads the API keys from ~/homelab/.env, which is gitignored.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HOST = os.environ.get('ARR_HOST', '192.168.68.59')
ENV = os.path.expanduser('~/homelab/.env')


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


def call(base, key, path, body=None):
    req = urllib.request.Request(
        f'{base}/api/v3/{path}',
        data=json.dumps(body).encode() if body is not None else None,
        method='POST' if body is not None else 'GET',
        headers={'X-Api-Key': key, 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def movies(key, apply_, limit, title=None, unreleased=False):
    base = f'http://{HOST}:7878'
    want = [m for m in call(base, key, 'movie')
            if m.get('monitored') and not m.get('hasFile')]
    # A film still in cinemas has nothing to find - Radarr knows, and says so
    # with isAvailable. Searching for it burns an indexer sweep to be told no.
    if not unreleased:
        skipped = [m for m in want if not m.get('isAvailable')]
        want = [m for m in want if m.get('isAvailable')]
        for m in skipped:
            print(f"  skip  {m['year']}  {m['title'][:46]} - not released yet")
    if title:
        want = [m for m in want if title.lower() in m['title'].lower()]
    if not want:
        print('  nothing missing')
        return 0
    for m in want[:limit]:
        print(f"  {m['year']}  {m['title'][:52]}")
    if len(want) > limit:
        print(f'  ... and {len(want) - limit} more')
    if apply_:
        # One command for all of them: Radarr queues the searches itself and
        # spaces them out, where one request per film would hammer every
        # indexer at once and risk a rate limit.
        call(base, key, 'command',
             {'name': 'MoviesSearch', 'movieIds': [m['id'] for m in want]})
        print(f'  -> searching {len(want)}')
    return len(want)


def episodes(key, apply_, limit, title=None):
    base = f'http://{HOST}:8989'
    page = call(base, key,
                'wanted/missing?pageSize=500&sortKey=airDateUtc&includeSeries=true')
    want = (page or {}).get('records', [])
    if title:
        want = [e for e in want
                if title.lower() in ((e.get('series') or {}).get('title', '')).lower()]
    if not want:
        print('  nothing missing')
        return 0
    for e in want[:limit]:
        series = (e.get('series') or {}).get('title', '?')
        print(f"  S{e.get('seasonNumber'):02}E{e.get('episodeNumber'):02}  {series[:46]}")
    if len(want) > limit:
        print(f'  ... and {len(want) - limit} more')
    if apply_:
        call(base, key, 'command',
             {'name': 'EpisodeSearch', 'episodeIds': [e['id'] for e in want]})
        print(f'  -> searching {len(want)}')
    return len(want)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='actually search')
    # Television is opt-in. A library with a few unfinished series has over a
    # hundred monitored missing episodes, and firing all of them at once is a
    # grab storm and an indexer rate limit, not a fix.
    ap.add_argument('--tv', action='store_true', help='include episodes')
    ap.add_argument('--no-movies', action='store_true')
    ap.add_argument('--title', help='only titles containing this')
    ap.add_argument('--unreleased', action='store_true',
                    help='include films Radarr says are not out yet')
    ap.add_argument('--limit', type=int, default=15, help='how many to list')
    args = ap.parse_args()

    keys = load_keys()
    total = 0
    try:
        if not args.no_movies and keys.get('RADARR_API_KEY'):
            print('== radarr, monitored and missing')
            total += movies(keys['RADARR_API_KEY'], args.apply, args.limit,
                            args.title, args.unreleased)
        if args.tv and keys.get('SONARR_API_KEY'):
            print('== sonarr, monitored and missing')
            total += episodes(keys['SONARR_API_KEY'], args.apply, args.limit,
                              args.title)
        elif not args.tv:
            print('== sonarr skipped (pass --tv to include episodes)')
    except urllib.error.HTTPError as e:
        sys.exit(f'{e.code}: {e.read().decode()[:200]}')

    print()
    if args.apply:
        print(f'{total} search(es) queued. Watch the queue, not this script - '
              f'grabs land over the next few minutes.')
    else:
        print(f'{total} would be searched. Re-run with --apply to do it.')


if __name__ == '__main__':
    main()
