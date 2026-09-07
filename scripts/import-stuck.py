#!/usr/bin/env python3
"""
Force the import of a download Sonarr finished but refused to file away.

Sonarr parses the *folder* a torrent landed in as well as the files inside it.
When the folder name reads like one episode - "Naruto Season 1 - Part 1" parses
as season 1, episode 1 - every other file in it is rejected with

    Episode 1x02 was unexpected considering the ... folder name

and the download sits in Activity > Queue as importBlocked. Season packs from
anime trackers are named this way constantly, so this is not a rare accident.

It is worse than one stuck import. A grab is recorded against every episode it
claimed - for an anime series with absolute numbering that can be the whole
run - and while those queue rows exist Sonarr believes those episodes are
already downloading and will not search for them again. One badly named folder
can stall four seasons.

The manual import API does not apply the folder rule, so this re-offers the
same files and they go in.

  scripts/import-stuck.py                   what is stuck, and what it would do
  scripts/import-stuck.py --title naruto    narrow it to one series
  scripts/import-stuck.py --apply           import, then drop the dead queue rows

Dry run by default. --apply imports and then removes the queue rows for
episodes the release could never have contained, which is what unblocks
searching for them again. The torrent is left in qBittorrent seeding and is
never blocklisted.

Reads the API key from ~/homelab/.env, which is gitignored.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HOST = os.environ.get('ARR_HOST', '192.168.68.59')
BASE = f'http://{HOST}:8989'
ENV = os.path.expanduser('~/homelab/.env')

# The states Sonarr uses for "finished downloading, not filed away".
STUCK = {'importBlocked', 'importPending', 'importFailed'}


def load_key():
    try:
        with open(ENV) as f:
            for line in f:
                line = line.strip()
                if line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                if k.strip() == 'SONARR_API_KEY':
                    return v.strip().strip('"').strip("'")
    except OSError as e:
        sys.exit(f'cannot read {ENV}: {e}')
    sys.exit(f'no SONARR_API_KEY in {ENV}')


def call(key, path, body=None, method=None):
    req = urllib.request.Request(
        f'{BASE}/api/v3/{path}',
        data=json.dumps(body).encode() if body is not None else None,
        method=method or ('POST' if body is not None else 'GET'),
        headers={'X-Api-Key': key, 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def stuck_downloads(key, title):
    """Queue rows grouped by download, since one download owns many rows."""
    page = call(key, 'queue?pageSize=2000&includeSeries=true')
    by_download = {}
    for row in (page or {}).get('records', []):
        if row.get('trackedDownloadState') not in STUCK:
            continue
        series = (row.get('series') or {}).get('title', '?')
        if title and title.lower() not in series.lower():
            continue
        d = by_download.setdefault(row.get('downloadId'), {
            'series': series,
            'title': row.get('title', '?'),
            'folder': row.get('outputPath'),
            'ids': [],
        })
        d['ids'].append(row['id'])
    return by_download


def importable(key, folder):
    """Files the manual import endpoint is happy with, one episode each."""
    files = call(key, 'manualimport?folder=' + urllib.parse.quote(folder)
                 + '&filterExistingFiles=true')
    out = []
    for f in files or []:
        eps = f.get('episodes') or []
        # No episode match, or a match Sonarr itself objects to, is not
        # something to force - that is the case where a human should look.
        if not eps or f.get('rejections'):
            continue
        # Already on disk under its library name: importing again duplicates it.
        if any(e.get('hasFile') for e in eps):
            continue
        out.append(f)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='actually import')
    ap.add_argument('--title', help='only series containing this')
    args = ap.parse_args()

    key = load_key()
    try:
        downloads = stuck_downloads(key, args.title)
        if not downloads:
            print('nothing stuck')
            return

        for download_id, d in downloads.items():
            print(f"== {d['series']}: {d['title'][:64]}")
            print(f"   {len(d['ids'])} queue rows, folder {d['folder']}")
            if not d['folder']:
                print('   no folder on the queue row - look at this one by hand')
                continue

            files = importable(key, d['folder'])
            if not files:
                # Nothing to force means this is not the folder-name trap, it is
                # a release with no usable episode in it - a .zipx pretending to
                # be a video, say. Dropping the row without blocklisting invites
                # Sonarr to grab the same thing again, so leave it alone.
                print('   nothing importable in it - not the folder-name trap.')
                print('   Deal with it by hand: Activity > Queue, remove and blocklist.')
                continue
            for f in files:
                e = f['episodes'][0]
                print('   S%02dE%02d  %s' % (e['seasonNumber'], e['episodeNumber'],
                                             f['relativePath'][:58]))

            if not args.apply:
                print(f'   would import {len(files)}, then drop '
                      f"{len(d['ids'])} queue rows")
                continue

            if files:
                cmd = call(key, 'command', {
                    'name': 'ManualImport',
                    'importMode': 'auto',   # hardlinks, so the torrent keeps seeding
                    'files': [{
                        'path': f['path'],
                        'folderName': f.get('folderName'),
                        'seriesId': f['series']['id'],
                        'episodeIds': [e['id'] for e in f['episodes']],
                        'quality': f['quality'],
                        'languages': f['languages'],
                        'releaseGroup': f.get('releaseGroup'),
                        'indexerFlags': f.get('indexerFlags', 0),
                        'downloadId': download_id,
                    } for f in files],
                })
                print(f"   -> import command {cmd['id']} queued for {len(files)} files")

            # removeFromClient=false leaves it seeding; blocklist=false so the
            # release can be grabbed again if it turns out to be the only one.
            call(key, 'queue/bulk?removeFromClient=false&blocklist=false'
                      '&skipRedownload=true&changeCategory=false',
                 {'ids': d['ids']}, method='DELETE')
            print(f"   -> dropped {len(d['ids'])} queue rows, torrent left seeding")

    except urllib.error.HTTPError as e:
        sys.exit(f'{e.code}: {e.read().decode()[:200]}')

    print()
    if args.apply:
        print('Imports run in the background. Missing episodes those rows were '
              'blocking can now be searched: scripts/search-missing.py --tv')
    else:
        print('Dry run. Re-run with --apply to do it.')


if __name__ == '__main__':
    main()
