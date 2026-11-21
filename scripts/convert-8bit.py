#!/usr/bin/env python3
"""
Turn 10-bit video into 8-bit H.264, once, in the folders you name.

Anime fansub releases are often H.264 10-bit ("Hi10P") or HEVC 10-bit. No
graphics chip decodes H.264 10-bit, browsers give up on it (worst when you
seek), and a 2012-era Intel GPU cannot transcode either format fast, so the
server ends up converting on the CPU during playback and every seek waits.
Converting the file once fixes it for every device.

Only the folders in CONVERT_8BIT_DIRS (comma-separated, relative to
MEDIA_ROOT) are touched; empty means nothing is converted. Audio, subtitles
and attached fonts are copied unchanged, so built-in subtitles stay in sync.
The new file replaces the original only when it has the same tracks and
length. It runs at low CPU priority and pauses when a live Jellyfin transcode
falls below MIN_FPS, so playback stays smooth; the swap waits until nobody
has the file open.

Runs from cron, one file at a time. --dry-run only lists what it would do.
A faster computer can take files off the same list with
convert-8bit-helper.mjs; every copy, wherever it was encoded, gets the same
checks here before it replaces anything.
"""
import argparse
import collections
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
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
    if value is not None and value != '':
        return value
    if default is None:
        raise SystemExit(f'{name} is not set: add it to {HOMELAB_DIR}/.env')
    return default


MEDIA = setting('MEDIA_ROOT').rstrip('/')
DIRS = [d.strip().strip('/') for d in setting('CONVERT_8BIT_DIRS', '').split(',') if d.strip()]
JELLYFIN = setting('JELLYFIN_HOST_URL', 'http://127.0.0.1:8096')
IN_CONTAINER = '/media'
FF = '/usr/lib/jellyfin-ffmpeg'
LOCK = os.path.join(STATE_DIR, '.convert-8bit.lock')
# Files whose conversion failed, with the size and time they had then. They are
# skipped until the file changes (an upgrade, a new release), instead of being
# encoded again in full every run only to fail the same way.
FAILED = os.path.join(STATE_DIR, 'convert-8bit.failed.json')
# Who is converting which file: this box, or a helper (convert-8bit-helper.mjs
# on a faster computer). A file is taken by one of them at a time. A claim that
# is never finished (the helper was switched off) lapses after CLAIM_TTL.
CLAIMS = os.path.join(STATE_DIR, 'convert-8bit.claims.json')
CLAIM_TTL = 3 * 3600
# What each file holds, per file version. Probing the whole library takes
# minutes; the box and a helper asking for work would otherwise each pay it.
PROBES = os.path.join(STATE_DIR, 'convert-8bit.probes.json')
QUEUE_LOCK = os.path.join(STATE_DIR, '.convert-8bit.queue.lock')
VIDEO = ('.mkv',)     # MP4 cannot carry the ASS subtitles and fonts the copy keeps
MIN_AGE = 600          # leave files alone while they may still be written
WORKER = 'convert-8bit'
MIN_FPS = 30           # a live transcode slower than this gets the whole CPU


def run(*args, timeout=120):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def probe(path):
    """{'streams': [(type, codec, pix_fmt)], 'duration': seconds} or None."""
    r = run('docker', 'exec', 'jellyfin', f'{FF}/ffprobe', '-v', 'fatal', '-show_entries',
            'stream=codec_type,codec_name,pix_fmt:format=duration', '-of', 'json',
            path.replace(MEDIA, IN_CONTAINER, 1))
    if r.returncode:
        return None
    d = json.loads(r.stdout or '{}')
    return {'streams': [(s.get('codec_type'), s.get('codec_name'), s.get('pix_fmt'))
                        for s in d.get('streams', [])],
            'duration': float(d.get('format', {}).get('duration') or 0)}


def ten_bit(info):
    return any(t == 'video' and '10' in (p or '') for t, _, p in info['streams'])


def sessions():
    """Jellyfin sessions that are playing something; [] when unknown."""
    key = setting('JELLYFIN_API_KEY', '')
    if not key:
        return []
    try:
        req = urllib.request.Request(f'{JELLYFIN}/Sessions',
                                     headers={'Authorization': f'MediaBrowser Token="{key}"'})
        return [s for s in json.load(urllib.request.urlopen(req, timeout=20)) if s.get('NowPlayingItem')]
    except Exception:
        return []


def transcoding():
    """True while a live Jellyfin transcode runs too slowly to stay ahead of
    playback. The conversion runs at a quarter of Jellyfin's CPU share, which
    left a 1080p transcode at 65 fps; below MIN_FPS it gives way entirely.
    A device that plays the file itself costs the server next to nothing."""
    for s in sessions():
        t = s.get('TranscodingInfo') or {}
        if (s.get('PlayState') or {}).get('PlayMethod') == 'Transcode' and t.get('Framerate'):
            if float(t['Framerate']) < MIN_FPS:
                return True
    return False


def playing(path):
    """True while someone has this very file open."""
    inside = path.replace(MEDIA, IN_CONTAINER, 1)
    return any(s['NowPlayingItem'].get('Path') == inside for s in sessions())


def candidates():
    """Files to look at. The episodes right after one someone is watching come
    first, in order, so the conversion stays ahead of the viewer. Then whole
    shows, smallest first: a show with hundreds of episodes would otherwise
    hold up every short show behind it in the alphabet for days."""
    found, show = [], {}
    for rel in DIRS:
        root = os.path.join(MEDIA, rel)
        for d, dirs, files in os.walk(root):
            dirs[:] = [x for x in dirs if not x.startswith('.')]
            for n in sorted(files):
                if n.lower().endswith(VIDEO) and not n.startswith('.'):
                    p = os.path.join(d, n)
                    if os.stat(p).st_mtime < time.time() - MIN_AGE:
                        found.append(p)
                        show[p] = os.path.join(root, os.path.relpath(p, root).split(os.sep)[0])
    size = collections.Counter(show.values())
    found.sort(key=lambda p: (size[show[p]], show[p], p))
    now = sorted(s['NowPlayingItem'].get('Path', '').replace(IN_CONTAINER, MEDIA, 1) for s in sessions())
    ahead = [p for p in found if any(os.path.dirname(p) == os.path.dirname(w) and p > w for w in now)]
    return ahead + [p for p in found if p not in ahead]


def stamp(path):
    st = os.stat(path)
    return f'{st.st_size}:{int(st.st_mtime)}'


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_json(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def file_id(path):
    """A short name for a file, so a helper never has to quote a path with
    spaces, quotes or semicolons through ssh."""
    return hashlib.sha1(path.encode()).hexdigest()[:12]


def temp_for(src):
    d, name = os.path.split(src)
    return os.path.join(d, f'.{os.path.splitext(name)[0]}.8bit.tmp.mkv')


def take_next(by, dry_run=False):
    """Claim the next file to convert for `by` and return (path, info), or None
    when nothing is left. Under QUEUE_LOCK, so two askers never get the same file."""
    with open(QUEUE_LOCK, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        probes, failed = load_json(PROBES), load_json(FAILED)
        claims = {k: c for k, c in load_json(CLAIMS).items()
                  if c['at'] > time.time() - CLAIM_TTL and os.path.exists(c['path'])}
        taken = {c['path'] for c in claims.values()}
        pick = None
        try:
            for src in candidates():
                try:
                    now = stamp(src)
                except FileNotFoundError:  # deleted since the folder was listed
                    continue
                if (probes.get(src) or [None])[0] != now:
                    probes[src] = [now, probe(src)]
                info = probes[src][1]
                if not info or not ten_bit(info) or failed.get(src) == now or src in taken:
                    continue
                if dry_run:
                    print(f'WOULD convert {os.path.relpath(src, MEDIA)}')
                    continue
                pick = (src, info)
                claims[file_id(src)] = {'path': src, 'by': by, 'at': time.time(), 'stamp': now}
                break
        finally:
            save_json(PROBES, {p: v for p, v in probes.items() if os.path.exists(p)})
            save_json(CLAIMS, claims)
        return pick


def claim(fid):
    c = load_json(CLAIMS).get(fid)
    if not c:
        raise SystemExit(f'{fid} is not claimed (lapsed after {CLAIM_TTL // 3600} h?)')
    return c


def release(fid):
    with open(QUEUE_LOCK, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        claims = load_json(CLAIMS)
        claims.pop(fid, None)
        save_json(CLAIMS, claims)


def kinds(info):
    """Track types and how many of each. The order may differ after a remux:
    Matroska writes a cover picture before the font attachments."""
    return sorted(t for t, _, _ in info['streams'])


def encode_here(src):
    """Encode src next to itself on this box. Returns the encoder's last errors."""
    d, name = os.path.split(src)
    tmp_name = os.path.basename(temp_for(src))
    image = run('docker', 'inspect', 'jellyfin', '-f', '{{.Config.Image}}').stdout.strip()
    st = os.stat(src)
    run('docker', 'rm', '-f', WORKER)
    # :V is video that is not a cover picture. A release with cover art carries
    # it as a second video track; encoding that too failed on its odd height.
    run('docker', 'run', '-d', '--name', WORKER, '--cpu-shares', '256',
        '--user', f'{st.st_uid}:{st.st_gid}', '-v', f'{d}:/work', '--entrypoint', f'{FF}/ffmpeg',
        image, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', f'/work/{name}',
        '-map', '0', '-c', 'copy', '-c:V', 'libx264', '-preset', 'veryfast', '-crf', '19',
        '-tune', 'animation', '-pix_fmt:V', 'yuv420p', '-profile:V', 'high', f'/work/{tmp_name}')
    paused = False
    while run('docker', 'ps', '-q', '-f', f'name=^{WORKER}$').stdout.strip():
        busy = transcoding()
        if busy and not paused:
            run('docker', 'pause', WORKER)
            paused = True
        elif not busy and paused:
            run('docker', 'unpause', WORKER)
            paused = False
        time.sleep(30)
    errors = run('docker', 'logs', '--tail', '3', WORKER).stderr.strip()
    run('docker', 'rm', '-f', WORKER)
    return errors


def finish(fid, errors=''):
    """Check the converted copy of a claimed file and swap it in. The same
    checks whoever encoded it. True when the file was replaced."""
    c = claim(fid)
    src, tmp, before = c['path'], temp_for(c['path']), c['stamp']
    try:
        if not os.path.exists(src) or stamp(src) != before:
            # Upgraded or deleted while it was being converted: the copy is of
            # a file that is no longer there. Not a failure of the new one.
            print(f'SKIPPED {os.path.relpath(src, MEDIA)}: changed while converting', flush=True)
            if os.path.exists(tmp):
                os.remove(tmp)
            return False
        ok = check_and_swap(src, tmp, errors, c['by'])
        failed = load_json(FAILED)
        if ok:
            failed.pop(src, None)
        else:
            failed[src] = before
        save_json(FAILED, failed)
        return ok
    finally:
        release(fid)


def check_and_swap(src, tmp, errors, by):
    info = probe(src)
    st = os.stat(src)
    new = probe(tmp) if os.path.exists(tmp) else None
    if not info:
        why = 'original no longer readable'
    elif not new:
        why = f'encoder failed: {errors}' if errors else 'no output'
    elif kinds(new) != kinds(info):
        why = f'tracks differ: {kinds(info)} -> {kinds(new)}'
    elif abs(new['duration'] - info['duration']) >= 1:
        why = f'length differs: {info["duration"]:.0f}s -> {new["duration"]:.0f}s'
    elif ten_bit(new):
        why = 'still 10-bit'
    else:
        why = None
    if why:
        print(f'FAILED  {os.path.relpath(src, MEDIA)}: {why}; original kept ({by})', flush=True)
        if os.path.exists(tmp):
            os.remove(tmp)
        return False
    while playing(src):  # a player may have the original open with byte ranges
        time.sleep(30)
    os.chmod(tmp, st.st_mode & 0o7777)
    os.replace(tmp, src)
    print(f'8-bit   {os.path.relpath(src, MEDIA)}: {st.st_size // 1000000} MB -> '
          f'{os.stat(src).st_size // 1000000} MB ({by})', flush=True)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    # Used by convert-8bit-helper.mjs over ssh; see there.
    ap.add_argument('--claim', metavar='HELPER', help='take the next file; prints {"id", "name"}')
    ap.add_argument('--send', metavar='ID', help='write the claimed original to stdout')
    ap.add_argument('--receive', metavar='ID', help='read the converted copy from stdin')
    ap.add_argument('--finish', metavar='ID', help='check the received copy and swap it in')
    ap.add_argument('--release', metavar='ID', help='give a claimed file back untouched')
    args = ap.parse_args()
    if not DIRS:
        return
    if args.claim:
        name = re.sub(r'[^\w.-]', '', args.claim)
        pick = take_next(name if name and name != 'box' else 'helper')
        if pick:
            print(json.dumps({'id': file_id(pick[0]), 'name': os.path.basename(pick[0])}))
        return
    if args.send:
        with open(claim(args.send)['path'], 'rb') as f:
            shutil.copyfileobj(f, sys.stdout.buffer, 1 << 20)
        return
    if args.receive:
        with open(temp_for(claim(args.receive)['path']), 'wb') as f:
            shutil.copyfileobj(sys.stdin.buffer, f, 1 << 20)
        return
    if args.finish:
        # The helper sees the verdict; the log on this box should show it too,
        # next to the files converted here.
        with open(os.path.join(STATE_DIR, 'convert-8bit.log'), 'a') as log:
            class Both:
                def write(self, s):
                    sys.__stdout__.write(s)
                    log.write(s)

                def flush(self):
                    sys.__stdout__.flush()
                    log.flush()
            sys.stdout = Both()
            try:
                return 0 if finish(args.finish) else 1
            finally:
                # Python flushes stdout once more at exit; with the log
                # closed by then, that failed and every swap answered "error".
                sys.stdout = sys.__stdout__
    if args.release:
        c = load_json(CLAIMS).get(args.release)
        if c and os.path.exists(temp_for(c['path'])):
            os.remove(temp_for(c['path']))
        release(args.release)
        return
    if args.dry_run:
        take_next('box', dry_run=True)
        return
    lock = open(LOCK, 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    # Only one box run at a time (LOCK), so a claim of the box's own is left
    # from a run that was stopped mid-file: take that file up again now.
    for fid, c in load_json(CLAIMS).items():
        if c['by'] == 'box':
            release(fid)
    # The order is worked out again after every file, so someone who starts
    # watching mid-run gets their next episodes first, and a show added or
    # removed meanwhile is noticed.
    while True:
        pick = take_next('box')
        if not pick:
            return
        finish(file_id(pick[0]), encode_here(pick[0]))


if __name__ == '__main__':
    sys.exit(main())
