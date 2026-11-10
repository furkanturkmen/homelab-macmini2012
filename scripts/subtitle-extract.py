#!/usr/bin/env python3
"""
Give every anime episode with English subtitles inside it a sidecar .en.srt.

A client that cannot draw the subtitles itself, or gets the video remuxed
(remote users over the relay), asks Jellyfin for the subtitle as a separate
stream. For a track inside an MKV, Jellyfin has to read the whole file to
pull it out: two and a half minutes for a 1.5 GB Aoashi episode on this
disk. The viewer sees no subtitles, restarts, and the extraction starts over
- Aoashi S2 and Dragon Ball Super were unwatchable for a remote viewer that way. A
sidecar is a few kilobytes and loads at once.

Only dialogue is kept. Crunchyroll and fansub ASS tracks carry signs,
karaoke and vector drawings that turn into hundreds of junk lines as SRT.
Episodes that already have an English sidecar (Bazarr's, or this script's)
are left alone, so does a file with no English text track; both are
remembered and not probed again.

Runs from cron. --dry-run only reports.
"""
import argparse
import fcntl
import json
import os
import re
import subprocess
import time
import sys

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
ROOTS = ('anime',)
FF = '/usr/lib/jellyfin-ffmpeg'
STATE = os.path.join(STATE_DIR, '.subtitle-extract-seen')
LOCK = os.path.join(STATE_DIR, '.subtitle-extract.lock')
VIDEO = ('.mkv',)
TEXT = ('ass', 'ssa', 'subrip')
EN_SIDECAR = re.compile(r'\.(?:[^.]+\.)?en(?:g)?(?:\.(?:hi|sdh|default))?\.(?:srt|ass)$', re.I)
# Styles that are never dialogue: songs, karaoke, on-screen text, titles.
# OPR/EDR/EDE: opening and ending in romaji or English (Goblin Slayer S02);
# snk4p2-ed1-tl: op/ed as a part anywhere in the name (Attack on Titan S04);
# Onscreen1: signs (JUJUTSU KAISEN S03); EDTL/EDRom/OPTrans (Steins;Gate).
NOT_DIALOGUE = re.compile(r'(^|[^a-z])(op|ed)[0-9]*([a-z]|tl|rom|romaji|eng?|jpn?|trans|kara)?([^a-z]|$)'
                          r'|opening|ending|romaji|kara|song|sign|onscreen|title|next|disclaimer|insert|lyric', re.I)
OVERRIDE = re.compile(r'\{[^}]*\}')
DRAWING = re.compile(r'\\p[1-9]')
# Text placed at a fixed spot is typeset on the picture - a sign, a
# blackboard, a phone screen (Steins;Gate 'BlackboardDerp', 2000 lines).
PLACED = re.compile(r'\\(pos|move)\(')


def ct(*args, timeout=900):
    return subprocess.run(['docker', 'exec', 'jellyfin', *args],
                          capture_output=True, text=True, timeout=timeout)


def english_track(inside):
    """Index of the English dialogue track, or None."""
    r = ct(f'{FF}/ffprobe', '-v', 'fatal', '-select_streams', 's', '-show_streams',
           '-of', 'json', inside, timeout=120)
    if r.returncode:
        return None
    best = None
    for s in json.loads(r.stdout or '{}').get('streams', []):
        tags = s.get('tags', {})
        lang = (tags.get('language') or '').lower()
        title = (tags.get('title') or '').lower()
        if s.get('codec_name') not in TEXT or lang not in ('eng', 'en'):
            continue
        if re.search(r'sign|song|forced', title) or s.get('disposition', {}).get('forced'):
            continue
        rank = (s.get('disposition', {}).get('default', 0), -s['index'])
        if best is None or rank > best[0]:
            best = (rank, s['index'])
    return best and best[1]


def ts(t):
    h, m, s = t.split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)


def srt_time(sec):
    ms = round(sec * 1000)
    return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}'


def dialogue(ass):
    """(start, end, text) for every line a viewer should read."""
    fields, out = None, []
    for line in ass.splitlines():
        if line.startswith('Format:') and fields is None and 'Start' in line:
            fields = [f.strip().lower() for f in line[7:].split(',')]
        elif line.startswith('Dialogue:') and fields:
            parts = line[9:].split(',', len(fields) - 1)
            ev = dict(zip(fields, (p.strip() for p in parts)))
            text = ev.get('text', '')
            # A filled Effect field is a generated karaoke syllable ('fx',
            # 'template', 'karaoke'), never a line of dialogue: Goblin Slayer
            # S02 had 15,000 of them under styles named after the band.
            if (ev.get('effect') or NOT_DIALOGUE.search(ev.get('style', ''))
                    or DRAWING.search(text) or PLACED.search(text)):
                continue
            text = OVERRIDE.sub('', text).replace('\\N', '\n').replace('\\n', '\n').replace('\\h', ' ')
            text = '\n'.join(l.strip() for l in text.split('\n') if l.strip())
            if text:
                out.append((ts(ev['start']), ts(ev['end']), text))
    out = sorted(set(out))
    return out


def to_srt(cues):
    return ''.join(f'{i}\n{srt_time(a)} --> {srt_time(b)}\n{t}\n\n'
                   for i, (a, b, t) in enumerate(cues, 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    lock = open(LOCK, 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    try:
        seen = set(open(STATE).read().splitlines())
    except OSError:
        seen = set()

    todo = []
    for root in ROOTS:
        for d, dirs, files in os.walk(os.path.join(MEDIA, root)):
            dirs[:] = [x for x in dirs if not x.startswith('.')]
            for n in files:
                if not n.lower().endswith(VIDEO):
                    continue
                p = os.path.join(d, n)
                st = os.stat(p)
                key = f'{p}\t{int(st.st_mtime)}'
                stem = os.path.splitext(n)[0]
                if key in seen or st.st_mtime > time.time() - 600:
                    continue
                if any(f.startswith(stem + '.') and EN_SIDECAR.search(f) for f in files):
                    seen.add(key)
                    continue
                todo.append((st.st_mtime, p, key))

    # newest first: what someone is watching this week matters more
    for _, p, key in sorted(todo, reverse=True):
        inside = p.replace(MEDIA, IN_CONTAINER, 1)
        rel = os.path.relpath(p, MEDIA)
        idx = english_track(inside)
        if idx is None:
            seen.add(key)
            continue
        if args.dry_run:
            print(f'WOULD extract track {idx}: {rel}')
            continue
        r = ct(f'{FF}/ffmpeg', '-nostdin', '-v', 'error', '-i', inside, '-map', f'0:{idx}', '-f', 'ass', '-')
        cues = dialogue(r.stdout) if r.returncode == 0 else []
        if len(cues) < 50:
            print(f'skip   {rel}: {len(cues)} dialogue lines in track {idx}', flush=True)
            seen.add(key)
            continue
        out = os.path.splitext(p)[0] + '.en.srt'
        tmp = os.path.join(os.path.dirname(out), '.' + os.path.basename(out) + '.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(to_srt(cues))
        os.chown(tmp, 1000, 1000)
        os.replace(tmp, out)
        seen.add(key)
        print(f'sidecar {os.path.basename(out)}: {len(cues)} lines from track {idx}', flush=True)
        with open(STATE, 'w') as f:
            f.write('\n'.join(sorted(seen)) + '\n')

    if not args.dry_run:
        with open(STATE, 'w') as f:
            f.write('\n'.join(sorted(seen)) + '\n')


if __name__ == '__main__':
    sys.exit(main())
