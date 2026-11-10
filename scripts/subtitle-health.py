#!/usr/bin/env python3
"""
Find sidecar subtitles that do not fit their video, and have Bazarr replace them.

Bazarr syncs every download to the audio (ffsubsync). When that sync fails it
does not say so - it writes a confident "offset of 48.86 seconds and a
framerate scale factor of 1.05" and stretches the file to match. On a
24-minute episode that pushes the last line to 26 minutes and leaves whole
scenes with nothing on screen: "subtitles disappear sometimes".

Bazarr's history cannot tell a bad sync from a good one - a 1.04 scale is the
correct fix for a 25 fps release - so this measures the files themselves,
against the runtime Jellyfin already knows:

  overrun   last line ends well after the video does
  truncated last line ends long before the video does
  hole      a long stretch with no line at all, mid-video
  sparse    far too few lines for the runtime (a signs-only track)
  bloated   far too many (karaoke and effects converted to text)

Read-only by default. --fix blacklists each flagged subtitle in Bazarr, which
deletes it and queues a new search; the blacklist keeps the same file from
coming straight back. --fix skips everything while Bazarr still has jobs
queued: a file it is halfway through writing reads as broken.
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.parse
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


MEDIA = setting('MEDIA_ROOT').rstrip('/')
IN_CONTAINER = '/media'
JELLYFIN = setting('JELLYFIN_HOST_URL', 'http://127.0.0.1:8096')
BAZARR = setting('BAZARR_HOST_URL', 'http://127.0.0.1:6767')
HOME = HOMELAB_DIR
BAZARR_DB = f'{HOME}/bazarr/config/db/bazarr.db'
BAZARR_CFG = f'{HOME}/bazarr/config/config/config.yaml'
VIDEO = ('.mkv', '.mp4', '.avi', '.m4v')
SIDECAR = re.compile(r'\.(?:[^.]+\.)?([a-z]{2,3})(?:\.(hi|forced|sdh))?\.srt$', re.I)
TS = re.compile(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)')

OVERRUN_S = 60          # a 'translated by' line after the credits is fine, not more
HOLE_S = {'episode': 300, 'movie': 900}   # 1917, The Revenant, Cast Away: 10 real minutes without a word
MIN_PER_MIN = 3         # fewer lines per minute than this is not dialogue
MAX_PER_MIN = 40        # more is not dialogue either
MAX_TRIES = 3           # blacklisted this often for one title and language: stop
# Lines overlapping by more than OVERLAP_S, as a share of all lines. A sign over
# dialogue is merged by subtitle-overlap.py; a file still this tangled is two
# tracks pasted together or karaoke syllables (JUJUTSU KAISEN, 2026-11-10).
OVERLAP_S = 0.5
TANGLED = 0.3
# Only where subtitle-overlap.py works too (anime by default).
OVERLAP_DIRS = tuple(os.path.join(MEDIA, d.strip()) + '/' for d in
                     setting('SUBTITLE_OVERLAP_DIRS', 'anime').split(',') if d.strip())


def env(key):
    with open(f'{HOME}/.env') as f:
        for line in f:
            if line.startswith(key + '='):
                return line.split('=', 1)[1].strip()
    sys.exit(f'{key} missing from {HOME}/.env')


def bazarr_key():
    with open(BAZARR_CFG) as f:
        in_auth = False
        for line in f:
            if re.match(r'^auth:', line):
                in_auth = True
            elif in_auth and re.match(r'^\S', line):
                in_auth = False
            elif in_auth and line.strip().startswith('apikey:'):
                return line.split(':', 1)[1].strip()
    sys.exit('no Bazarr apikey in config.yaml')


def runtimes():
    """host path of every video -> (seconds, 'episode'|'movie'), from Jellyfin."""
    q = urllib.parse.urlencode({'Recursive': 'true', 'IncludeItemTypes': 'Episode,Movie',
                                'Fields': 'Path', 'EnableImages': 'false'})
    req = urllib.request.Request(f'{JELLYFIN}/Items?{q}', headers={
        'Authorization': f'MediaBrowser Token={env("JELLYFIN_API_KEY")}'})
    items = json.load(urllib.request.urlopen(req, timeout=120))['Items']
    out = {}
    for i in items:
        if i.get('Path') and i.get('RunTimeTicks'):
            out[i['Path'].replace(IN_CONTAINER, MEDIA, 1)] = (
                i['RunTimeTicks'] / 1e7, 'episode' if i['Type'] == 'Episode' else 'movie')
    return out


def cues(path):
    text = open(path, 'rb').read().decode('utf-8', 'replace')
    out = []
    for m in TS.finditer(text):
        g = [int(x) for x in m.groups()]
        out.append((g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000,
                    g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000))
    return sorted(out)


def judge(c, runtime, kind, overlap_dir=False):
    if not c:
        return ['empty']
    problems = []
    last = max(e for _, e in c)
    if last > runtime + OVERRUN_S:
        problems.append(f'overrun {last - runtime:+.0f}s')
    end, hole = c[0][1], (0, 0)
    for a, e in c[1:]:
        if a - end > hole[1]:
            hole = (end, a - end)
        end = max(end, e)
    if hole[1] > HOLE_S[kind]:
        problems.append(f'hole {hole[1] / 60:.1f}min at {hole[0] / 60:.1f}min')
    # Half a film: CD1 of a two-part release, or a file cut off mid-upload.
    # The same allowance as a hole covers the credits.
    if runtime - last > HOLE_S[kind]:
        problems.append(f'truncated, ends at {last / 60:.1f} of {runtime / 60:.1f}min')
    tangled = sum(1 for (_, e), (a, _) in zip(c, c[1:]) if e - a > OVERLAP_S)
    if overlap_dir and tangled > TANGLED * len(c):
        problems.append(f'tangled, {tangled} of {len(c)} lines overlap')
    per_min = len(c) / (runtime / 60)
    if per_min < MIN_PER_MIN:
        problems.append(f'sparse {len(c)} lines')
    elif per_min > MAX_PER_MIN:
        problems.append(f'bloated {len(c)} lines')
    return problems


def scan():
    rt = runtimes()
    for video, (runtime, kind) in sorted(rt.items()):
        d, stem = os.path.dirname(video), os.path.splitext(os.path.basename(video))[0]
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for n in sorted(names):
            if not (n.startswith(stem + '.') and SIDECAR.search(n)):
                continue
            path = os.path.join(d, n)
            problems = judge(cues(path), runtime, kind, path.startswith(OVERLAP_DIRS))
            if problems:
                yield video, path, kind, problems


def last_download(db, path, kind):
    """What Bazarr needs to blacklist a file: provider, subs_id, language, ids."""
    inside = path.replace(MEDIA, IN_CONTAINER, 1)
    if kind == 'episode':
        r = db.execute('select provider, subs_id, language, sonarrSeriesId, sonarrEpisodeId '
                       'from table_history where subtitles_path=? and action in (1,2,3) '
                       'and provider is not null order by timestamp desc limit 1', (inside,)).fetchone()
    else:
        r = db.execute('select provider, subs_id, language, radarrId, null '
                       'from table_history_movie where subtitles_path=? and action in (1,2,3) '
                       'and provider is not null order by timestamp desc limit 1', (inside,)).fetchone()
    return r


def tries(db, kind, row):
    """How often this title and language were blacklisted already."""
    _, _, lang, a, b = row
    lang = lang.split(':')[0]
    if kind == 'episode':
        return db.execute('select count(*) from table_blacklist where sonarr_episode_id=? '
                          'and language like ?', (b, lang + '%')).fetchone()[0]
    return db.execute('select count(*) from table_blacklist_movie where radarr_id=? '
                      'and language like ?', (a, lang + '%')).fetchone()[0]


def blacklist(key, kind, row, path):
    provider, subs_id, lang, a, b = row
    inside = path.replace(MEDIA, IN_CONTAINER, 1)
    if kind == 'episode':
        url = f'{BAZARR}/api/episodes/blacklist?seriesid={a}&episodeid={b}'
    else:
        url = f'{BAZARR}/api/movies/blacklist?radarrid={a}'
    body = urllib.parse.urlencode({'provider': provider, 'subs_id': subs_id,
                                   'language': lang.split(':')[0],
                                   'subtitles_path': inside}).encode()
    # The blacklist call also queues "Downloading missing subtitles" for the
    # title, so the replacement arrives without asking. Do not queue a second
    # search on top: two jobs syncing the same file at once lost it outright.
    # The queue is slow - each download is synced to the audio, ~30s apiece.
    req = urllib.request.Request(url, data=body, method='POST', headers={'X-API-KEY': key})
    return urllib.request.urlopen(req, timeout=600).status


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fix', action='store_true',
                    help='blacklist flagged subtitles in Bazarr (deletes them, searches again)')
    ap.add_argument('--only', help='only paths containing this text')
    args = ap.parse_args()

    found = [x for x in scan() if not args.only or args.only.lower() in x[1].lower()]
    for video, path, kind, problems in found:
        print(f'{os.path.relpath(path, MEDIA)}\n    {", ".join(problems)}')
    print(f'\n{len(found)} subtitle files do not fit their video')
    if not args.fix:
        return

    key = bazarr_key()
    req = urllib.request.Request(f'{BAZARR}/api/system/jobs', headers={'X-API-KEY': key})
    busy = [j for j in json.load(urllib.request.urlopen(req, timeout=60)).get('data', [])
            if j.get('status') in ('pending', 'running')]
    if busy:
        print(f'Bazarr has {len(busy)} jobs queued, not fixing anything until it is idle')
        return
    db = sqlite3.connect(f'file:{BAZARR_DB}?mode=ro', uri=True)
    for video, path, kind, problems in found:
        row = last_download(db, path, kind)
        name = os.path.basename(path)
        if not row:
            print(f'skip   {name}: not downloaded by Bazarr, nothing to blacklist')
            continue
        # A video in a cut nobody subtitles (Watchmen theatrical among Ultimate
        # Cut subs, The Office "Superfan" episodes) only ever gets the wrong
        # one back. Keep the last one rather than churn through every upload.
        if tries(db, kind, row) >= MAX_TRIES:
            print(f'keep   {name}: {MAX_TRIES} replacements did not fit either')
            continue
        try:
            print(f'replace {name}: HTTP {blacklist(key, kind, row, path)}')
        except Exception as e:
            print(f'ERROR  {name}: {e}')


if __name__ == '__main__':
    main()
