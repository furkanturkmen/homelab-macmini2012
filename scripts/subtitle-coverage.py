#!/usr/bin/env python3
"""
Which subtitle languages each title actually has - sidecar and embedded.

Counting only .srt files on disk is misleading and reads as a much worse
library than it is. Bazarr runs with use_embedded_subs on, so it deliberately
does not fetch a language the file already carries: Maleficent (2014) ships
English SDH inside, Tokyo Ghoul and Steins;Gate ship English fansubs inside,
and Now You See Me ships Turkish. All of those look like gaps from the outside
and are not.

One representative file is probed per title. A season is packed by one group
in one pass, so its embedded tracks are the same throughout, and probing 86
episodes to learn the same fact is not worth the minutes.

Read-only.
"""
import argparse
import collections
import json
import os
import re
import subprocess

ROOTS = ('movies', 'tv', 'anime')
MEDIA = '/mnt/storage/media'
IN_CONTAINER = '/media'
VIDEO = ('.mkv', '.mp4', '.avi', '.m4v')
SIDECAR = re.compile(r'\.([a-z]{2,3})(?:\.(?:hi|forced|sdh))?\.(?:srt|ass|ssa|sub)$', re.I)

# ISO-639-2 to the two-letter codes the profile uses.
NORM = {'eng': 'en', 'nld': 'nl', 'dut': 'nl', 'tur': 'tr', 'jpn': 'ja',
        'zho': 'zh', 'chi': 'zh', 'spa': 'es', 'por': 'pt', 'ger': 'de',
        'deu': 'de', 'fre': 'fr', 'fra': 'fr', 'ita': 'it'}
WANT = ('en', 'nl', 'tr')


def norm(code):
    code = (code or '').lower()
    return NORM.get(code, code)


def embedded(path):
    """Subtitle languages inside the container, via Jellyfin's ffmpeg."""
    inside = path.replace(MEDIA, IN_CONTAINER, 1)
    try:
        out = subprocess.run(
            ['docker', 'exec', 'jellyfin', '/usr/lib/jellyfin-ffmpeg/ffprobe',
             '-v', 'error', '-select_streams', 's',
             '-show_entries', 'stream_tags=language', '-of', 'csv=p=0', inside],
            capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return set()
    return {norm(l.strip()) for l in out.splitlines() if l.strip()}


def scan(root, probe=True):
    base = os.path.join(MEDIA, root)
    if not os.path.isdir(base):
        return
    for title in sorted(os.listdir(base)):
        d = os.path.join(base, title)
        if not os.path.isdir(d):
            continue
        side = collections.Counter()
        first_video = None
        videos = 0
        for dirpath, _, files in os.walk(d):
            for f in sorted(files):
                if f.lower().endswith(VIDEO):
                    videos += 1
                    first_video = first_video or os.path.join(dirpath, f)
                m = SIDECAR.search(f)
                if m:
                    side[norm(m.group(1))] += 1
        if not videos:
            continue
        inside = embedded(first_video) if (probe and first_video) else set()
        yield title, videos, side, inside


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-probe', action='store_true',
                    help='skip ffprobe; sidecars only, and much faster')
    ap.add_argument('--missing', action='store_true',
                    help='only titles lacking one of the wanted languages')
    args = ap.parse_args()

    totals = collections.Counter()
    for root in ROOTS:
        rows = list(scan(root, probe=not args.no_probe))
        if not rows:
            continue
        print(f'== {root}')
        for title, videos, side, inside in rows:
            cells, gaps = [], []
            for lang in WANT:
                if side.get(lang):
                    cells.append(f'{lang}:{side[lang]}')
                    totals[lang] += 1
                elif lang in inside:
                    # Present, just not as a file. Bazarr is right not to fetch it.
                    cells.append(f'{lang}:embedded')
                    totals[lang] += 1
                else:
                    cells.append(f'{lang}:-')
                    gaps.append(lang)
            if args.missing and not gaps:
                continue
            tail = f'   <- no {", ".join(gaps)}' if gaps else ''
            print(f'   {title[:36]:38} {videos:3} files  {"  ".join(cells)}{tail}')
        print()

    print(f'titles covered per language: '
          + '  '.join(f'{k}={v}' for k, v in sorted(totals.items())))


if __name__ == '__main__':
    main()
