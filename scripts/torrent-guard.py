#!/usr/bin/env python3
"""
Kill torrents whose contents are not what was asked for.

Written after Sonarr grabbed a release titled

    House.of.the.Dragon.S03E05.ITA.ENG.1080p.AMZN.WEB-DL.DDP5.1.H.264 MeM.GP.mkv

whose payload was a single 837 MB Windows executable padded out to look like a
video. It reached 100% and began seeding before anyone noticed.

Nothing upstream can prevent that. Sonarr and Prowlarr only ever see a release
*title*, and that title was entirely plausible - so no naming rule would have
caught it without also rejecting legitimate grabs. The first moment the truth is
knowable is when the torrent's metadata resolves and qBittorrent can list the
files inside, which is what this checks.

The test is deliberately narrow. A hostile extension inside a torrent that
Sonarr or Radarr asked for is never legitimate, so that case is removed
outright. "No media file at all" is only reported, never acted on, because
scene releases legitimately ship as split archives with no video extension in
sight and a false positive there would delete something real.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

QB_HOST = 'http://127.0.0.1:8083'
VPN_CONTAINER = 'gluetun'  # qBittorrent shares this container's network namespace
ENV_FILE = '/home/furkan/homelab/.env'
STATE_FILE = '/home/furkan/homelab-scripts/.torrent-guard-seen'

# Executables and script types. None of these belong in a film or an episode.
HOSTILE = {
    '.exe', '.scr', '.bat', '.cmd', '.com', '.msi', '.vbs', '.vbe', '.js', '.jse',
    '.wsf', '.wsh', '.ps1', '.lnk', '.reg', '.hta', '.pif', '.cpl', '.jar', '.apk',
}
MEDIA = {
    '.mkv', '.mp4', '.avi', '.m4v', '.mov', '.ts', '.m2ts', '.wmv', '.flv', '.webm',
    '.mpg', '.mpeg', '.ogm', '.rmvb', '.iso', '.img',
}
# Categories the *arr apps use. Anything hand-added is left alone.
ARR_CATEGORIES = {'tv-sonarr', 'radarr', 'movies-radarr', 'sonarr'}


def qb(path, post=None):
    cmd = ['docker', 'exec', VPN_CONTAINER, 'wget', '-qO-', '-T', '20']
    if post is not None:
        cmd += ['--post-data', post]
    cmd.append(f'{QB_HOST}{path}')
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    return r.stdout


def env(name):
    try:
        with open(ENV_FILE) as f:
            for line in f:
                if line.startswith(f'{name}='):
                    return line.split('=', 1)[1].strip().strip('"\'')
    except OSError:
        pass
    return ''


def notify(title, body, priority='high', tags='warning'):
    topic, user, pw = env('NTFY_TOPIC'), env('NTFY_USER'), env('NTFY_PASSWORD')
    if not topic:
        return
    req = urllib.request.Request(
        f'http://localhost:8095/{topic}',
        data=body.encode(),
        headers={'Title': title, 'Priority': priority, 'Tags': tags},
    )
    if user:
        import base64
        token = base64.b64encode(f'{user}:{pw}'.encode()).decode()
        req.add_header('Authorization', f'Basic {token}')
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:
        print(f'ntfy failed: {e}', file=sys.stderr)


def load_seen():
    try:
        with open(STATE_FILE) as f:
            return set(x.strip() for x in f if x.strip())
    except OSError:
        return set()


def save_seen(seen):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    # bounded: only hashes still present matter, so this cannot grow forever
    with open(STATE_FILE, 'w') as f:
        f.write('\n'.join(sorted(seen)) + '\n')


def main():
    dry = '--dry-run' in sys.argv
    try:
        torrents = json.loads(qb('/api/v2/torrents/info') or '[]')
    except json.JSONDecodeError:
        print('cannot reach qBittorrent', file=sys.stderr)
        return 1

    seen = load_seen()
    live = set()
    removed, flagged = [], []

    for t in torrents:
        h, name = t['hash'], t['name']
        live.add(h)
        try:
            files = json.loads(qb(f'/api/v2/torrents/files?hash={h}') or '[]')
        except json.JSONDecodeError:
            continue
        if not files:
            continue  # metadata has not resolved yet; next run will see it

        exts = [os.path.splitext(f['name'])[1].lower() for f in files]
        hostile = sorted({e for e in exts if e in HOSTILE})
        has_media = any(e in MEDIA for e in exts)
        arr = (t.get('category') or '') in ARR_CATEGORIES

        if hostile and arr:
            biggest = max(files, key=lambda f: f.get('size', 0))
            detail = (
                f"{name[:70]}\n"
                f"contains: {', '.join(hostile)}\n"
                f"largest file: {biggest['name'][:60]} "
                f"({biggest.get('size', 0) / 2**20:.0f} MiB)\n"
                f"progress was {t.get('progress', 0) * 100:.0f}%"
            )
            print(f'REMOVE {h} {name[:60]} -> {hostile}')
            if not dry:
                qb('/api/v2/torrents/stop', f'hashes={h}')
                qb('/api/v2/torrents/delete', f'hashes={h}&deleteFiles=true')
            removed.append(detail)

        elif arr and not has_media and h not in seen:
            # Reported only. Split archives are legitimate and look like this.
            print(f'FLAG   {h} {name[:60]} -> no media extension')
            flagged.append(f"{name[:70]}\nno video file in {len(files)} file(s) - check it")
            seen.add(h)

    for d in removed:
        notify('Malware torrent removed', d, priority='urgent', tags='rotating_light')
    for d in flagged:
        notify('Torrent has no video file', d, priority='default', tags='mag')

    save_seen(seen & live)
    if not removed and not flagged:
        print(f'ok - {len(torrents)} torrent(s), nothing hostile')
    return 0


if __name__ == '__main__':
    sys.exit(main())
