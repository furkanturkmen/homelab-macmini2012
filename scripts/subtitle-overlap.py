#!/usr/bin/env python3
"""
Make SRT subtitles whose lines overlap in time readable on every player.

Anime subtitles are mostly converted from fansub ASS files, where a sign
("Kaga Michio" on a status screen) sits at the top of the picture while the
dialogue runs at the bottom. SRT has no position, so after conversion both
lines are drawn in the same spot over each other and neither can be read.
The same happens when two people talk at once.

This rewrites such files so no two cues are on screen at the same time:
an overlap shorter than half a second just ends the earlier line sooner,
a real overlap becomes one cue with both lines stacked. No text is lost.
Files without overlaps are not touched. Checked files are remembered by
path and modification time, so each one is read once.

Karaoke left-overs (a lone note or letter per cue) and lines repeated from a
second copy of the track are dropped first. A file where many lines still
overlap after that is a bad conversion, not signs: it is logged as broken
and left alone, to be replaced rather than merged.

Only the folders in SUBTITLE_OVERLAP_DIRS under MEDIA_ROOT (default: anime).
Runs from cron. --dry-run only reports; --file checks one file.
"""
import argparse
import fcntl
import os
import re
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


STATE = os.path.join(STATE_DIR, '.subtitle-overlap-seen')
LOCK = os.path.join(STATE_DIR, '.subtitle-overlap.lock')
TIME = re.compile(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)')
EMPTY_TAG = re.compile(r'<([ibu])>\s*</\1>', re.I)
TAG = re.compile(r'<[^>]+>|\{[^}]*\}')
TRIM = 0.5       # overlaps shorter than this only shorten the earlier line
MIN_PIECE = 0.2  # pieces shorter than this are folded into the one before
BROKEN = 0.3     # more overlapping lines than this share: a bad file, not signs


def junk(text):
    """Karaoke left-overs: a lone note, letter or bit of punctuation."""
    letters = [ch for ch in TAG.sub('', text) if ch.isalnum()]
    return len(letters) <= 1


def norm(text):
    return ' '.join(TAG.sub('', text).split()).lower()


def clean(cues):
    """Without karaoke junk, and without a line that repeats one already on
    screen (two copies of the same track pasted into one file)."""
    out = []
    for c in sorted(cues):
        if junk(c[2]):
            continue
        twin = next((o for o in reversed(out[-8:]) if o[1] > c[0] and norm(o[2]) == norm(c[2])), None)
        if twin:
            out[out.index(twin)] = (twin[0], max(twin[1], c[1]), twin[2])
            continue
        out.append(c)
    return out


def sec(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, '0')[:3]) / 1000


def stamp(t):
    ms = round(t * 1000)
    return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}'


def parse(text):
    """[(start, end, text)] or None when the file is not plain SRT."""
    cues = []
    for block in re.split(r'\n\s*\n', text.replace('\r\n', '\n').replace('\r', '\n')):
        lines = block.strip('\n').split('\n')
        for i, line in enumerate(lines[:2]):
            m = TIME.search(line)
            if m:
                body = EMPTY_TAG.sub('', '\n'.join(lines[i + 1:])).strip()
                if body:
                    g = m.groups()
                    cues.append((sec(*g[:4]), sec(*g[4:]), body))
                break
        else:
            if block.strip() and not block.strip().isdigit():
                return None
    return cues


def flatten(cues):
    """Cues rebuilt so that at most one is on screen at any moment."""
    cues = sorted((a, b, t) for a, b, t in cues if b > a)
    # 1. near-misses: end the earlier line where the next one starts
    out = []
    for a, b, t in cues:
        if out and a < out[-1][1] and out[-1][1] - a < TRIM and out[-1][0] < a:
            pa, _, pt = out[-1]
            out[-1] = (pa, a, pt)
        out.append((a, b, t))
    cues = out
    # 2. real overlaps: cut at every start and end, stack what is showing
    edges = sorted({x for a, b, _ in cues for x in (a, b)})
    pieces = []
    for a, b in zip(edges, edges[1:]):
        live = [c for c in cues if c[0] < b and c[1] > a]
        if not live:
            continue
        seen, lines = set(), []
        for c in sorted(live):
            if c[2] not in seen:
                seen.add(c[2])
                lines.append(c[2])
        pieces.append([a, b, '\n'.join(lines)])
    # 3. fold slivers and join neighbours that show the same text
    merged = []
    for p in pieces:
        if merged and merged[-1][1] == p[0] and (merged[-1][2] == p[2] or p[1] - p[0] < MIN_PIECE):
            merged[-1][1] = p[1]
        else:
            merged.append(p)
    return [tuple(p) for p in merged]


def overlaps(cues):
    cues = sorted(cues)
    return sum(1 for x, y in zip(cues, cues[1:]) if y[0] < x[1])


def to_srt(cues):
    return ''.join(f'{i}\n{stamp(a)} --> {stamp(b)}\n{t}\n\n' for i, (a, b, t) in enumerate(cues, 1))


def fix(path, dry_run):
    """(overlaps removed, junk lines dropped), or None for a file to leave
    alone: unreadable, or so tangled it needs replacing, not merging."""
    try:
        raw = open(path, 'rb').read()
        text = raw.decode('utf-8-sig')
    except (OSError, UnicodeDecodeError):
        return 0, 0
    cues = parse(text)
    if not cues:
        return 0, 0
    n = overlaps(cues)
    if not n:
        return 0, 0
    kept = clean(cues)
    dropped = len(cues) - len(kept)
    n = overlaps(kept)
    if not kept or n > BROKEN * len(kept):
        return None
    cues = kept
    if dry_run:
        return n, dropped
    st = os.stat(path)
    tmp = os.path.join(os.path.dirname(path), '.' + os.path.basename(path) + '.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(to_srt(flatten(cues)))
    os.chmod(tmp, st.st_mode & 0o7777)
    try:
        os.chown(tmp, st.st_uid, st.st_gid)
    except PermissionError:
        pass
    os.replace(tmp, path)
    return n, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--file', help='check this one file and print the result')
    ap.add_argument('--fix-file', help='fix this one file in place if it lies in SUBTITLE_OVERLAP_DIRS '
                                       '(Bazarr post-processing; never fails the download)')
    args = ap.parse_args()

    if args.fix_file:
        try:
            media = setting('MEDIA_ROOT').rstrip('/')
            roots = [os.path.join(media, r.strip()) + '/' for r in
                     setting('SUBTITLE_OVERLAP_DIRS', 'anime').split(',') if r.strip()]
            p = os.path.abspath(args.fix_file)
            if p.lower().endswith('.srt') and any(p.startswith(r) for r in roots):
                r = fix(p, False)
                if r is None:
                    print(f'broken {p}: most lines overlap, left as is')
                elif any(r):
                    print(f'fixed {r[0]} overlaps {r[1]} junk  {p}')
        except Exception as e:  # a post-processing error must not undo the download
            print(f'subtitle-overlap: {e}')
        return

    if args.file:
        cues = parse(open(args.file, encoding='utf-8-sig').read())
        kept = clean(cues)
        print(f'{overlaps(cues)} overlaps, {overlaps(kept)} after dropping '
              f'{len(cues) - len(kept)} junk or repeated lines of {len(cues)}', file=sys.stderr)
        cues = kept
        sys.stdout.write(to_srt(flatten(cues)))
        return

    media = setting('MEDIA_ROOT').rstrip('/')
    roots = [r.strip() for r in setting('SUBTITLE_OVERLAP_DIRS', 'anime').split(',') if r.strip()]
    lock = open(LOCK, 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    try:
        seen = set(open(STATE).read().splitlines())
    except OSError:
        seen = set()

    done = set()
    walk = (w for r in roots for w in os.walk(os.path.join(media, r)))
    for d, dirs, files in walk:
        dirs[:] = [x for x in dirs if not x.startswith('.')]
        for name in files:
            if not name.lower().endswith('.srt') or name.startswith('.'):
                continue
            p = os.path.join(d, name)
            key = f'{p}\t{int(os.stat(p).st_mtime)}'
            if key in seen:
                done.add(key)
                continue
            r = fix(p, args.dry_run)
            rel = os.path.relpath(p, media)
            if r is None:
                print(f'broken {rel}: most lines overlap, left as is', flush=True)
            elif any(r):
                print(f'{"WOULD fix" if args.dry_run else "fixed"} {r[0]:4} overlaps {r[1]:4} junk  {rel}',
                      flush=True)
                if not args.dry_run:
                    key = f'{p}\t{int(os.stat(p).st_mtime)}'
            if not args.dry_run:
                done.add(key)

    if not args.dry_run:
        with open(STATE, 'w') as f:
            f.write('\n'.join(sorted(done)) + '\n')


if __name__ == '__main__':
    sys.exit(main())
