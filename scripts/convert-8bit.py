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
"""
import argparse
import fcntl
import json
import os
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
    first, in order, so the conversion stays ahead of the viewer."""
    found = []
    for rel in DIRS:
        for d, dirs, files in os.walk(os.path.join(MEDIA, rel)):
            dirs[:] = [x for x in dirs if not x.startswith('.')]
            for n in sorted(files):
                if n.lower().endswith(VIDEO) and not n.startswith('.'):
                    p = os.path.join(d, n)
                    if os.stat(p).st_mtime < time.time() - MIN_AGE:
                        found.append(p)
    found.sort()
    now = sorted(s['NowPlayingItem'].get('Path', '').replace(IN_CONTAINER, MEDIA, 1) for s in sessions())
    ahead = [p for p in found if any(os.path.dirname(p) == os.path.dirname(w) and p > w for w in now)]
    return ahead + [p for p in found if p not in ahead]


def stamp(path):
    st = os.stat(path)
    return f'{st.st_size}:{int(st.st_mtime)}'


def load_failed():
    try:
        with open(FAILED) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_failed(failed):
    tmp = FAILED + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(failed, f, indent=1, sort_keys=True)
    os.replace(tmp, FAILED)


def kinds(info):
    """Track types and how many of each. The order may differ after a remux:
    Matroska writes a cover picture before the font attachments."""
    return sorted(t for t, _, _ in info['streams'])


def convert(src, info):
    """True when the file was replaced, False when the conversion failed."""
    d, name = os.path.split(src)
    tmp_name = f'.{os.path.splitext(name)[0]}.8bit.tmp.mkv'
    tmp = os.path.join(d, tmp_name)
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
    new = probe(tmp) if os.path.exists(tmp) else None
    if not new:
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
        print(f'FAILED  {os.path.relpath(src, MEDIA)}: {why}; original kept', flush=True)
        if os.path.exists(tmp):
            os.remove(tmp)
        return False
    while playing(src):  # a player may have the original open with byte ranges
        time.sleep(30)
    os.chmod(tmp, st.st_mode & 0o7777)
    os.replace(tmp, src)
    print(f'8-bit   {os.path.relpath(src, MEDIA)}: {st.st_size // 1000000} MB -> '
          f'{os.stat(src).st_size // 1000000} MB', flush=True)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    if not DIRS:
        return
    lock = open(LOCK, 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    for src in candidates():
        info = probe(src)
        if not info or not ten_bit(info):
            continue
        if args.dry_run:
            print(f'WOULD convert {os.path.relpath(src, MEDIA)}')
            continue
        failed = load_failed()
        if failed.get(src) == stamp(src):
            continue
        before = stamp(src)
        ok = convert(src, info)
        failed = load_failed()
        if ok:
            failed.pop(src, None)
        else:
            failed[src] = before
        save_failed(failed)


if __name__ == '__main__':
    sys.exit(main())
