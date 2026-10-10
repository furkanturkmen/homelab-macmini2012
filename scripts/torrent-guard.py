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

Removal goes *through* Sonarr or Radarr rather than straight to qBittorrent,
because a kill that does not blocklist is an infinite loop. "Fall 2022 PROPER
1080p WEBRip x265 RARBG" was grabbed, killed here, and grabbed again fifty-five
minutes later - the identical release, because deleting the torrent left Radarr
with no record that anything was wrong and its ranking still put that release
first. Blocklisting is what makes a kill stick, and it also triggers a fresh
search that will pick something else.

Falls back to deleting straight from qBittorrent when no queue row matches the
hash, which covers a torrent added by hand and an *arr that is down. That path
does not blocklist, so it says so in the notification.
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

# Published ports on the host, not the container names the compose file uses:
# this runs from cron on the host, where "http://sonarr:8989" does not resolve.
ARRS = (
    ('sonarr', 'http://127.0.0.1:8989', 'SONARR_API_KEY'),
    ('radarr', 'http://127.0.0.1:7878', 'RADARR_API_KEY'),
)


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
    # Headers are Latin-1; a series name outside ASCII goes as an RFC 2047
    # encoded-word, which ntfy decodes.
    if not title.isascii():
        import base64
        title = f'=?UTF-8?B?{base64.b64encode(title.encode()).decode()}?='
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


def arr(base, key, path, method='GET', body=None):
    req = urllib.request.Request(
        f'{base}/api/v3/{path}',
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={'X-Api-Key': key, 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def remove_and_blocklist(h, dry):
    """Remove a torrent so that it stays removed.

    Deleting it from qBittorrent alone is not enough. Radarr keeps no record
    that the release was bad, its ranking still puts that release first, and
    the next search grabs the same file again - which is exactly what happened
    to Fall (2022), twice, fifty-five minutes apart.

    Going through the queue API instead does all three things at once: removes
    it from the client with its data, blocklists the release so it can never be
    chosen again, and starts a fresh search.

    Sonarr queues one row per *episode*, so a season pack is many rows sharing
    one downloadId. All of them go together, or the leftovers sit in the queue
    pointing at a torrent that no longer exists.

    Returns (what happened, what it was for), both in plain words for the
    notification; the second is None when no queue row says.
    """
    for name, base, keyvar in ARRS:
        key = env(keyvar)
        if not key:
            continue
        try:
            queue = arr(base, key, 'queue?pageSize=500&includeSeries=true&includeEpisode=true&includeMovie=true')
            rows = [r for r in (queue or {}).get('records', [])
                    if (r.get('downloadId') or '').lower() == h.lower()]
            if not rows:
                continue
            what = wanted_for(rows)
            if dry:
                return f'Would be deleted and blocked in {name.capitalize()} (dry run).', what
            arr(base, key,
                'queue/bulk?removeFromClient=true&blocklist=true&skipRedownload=false',
                method='DELETE', body={'ids': [r['id'] for r in rows]})
            return ('Deleted and blocked, and a search for a real copy has started. '
                    'Nothing to do.'), what
        except Exception as e:
            print(f'{name} blocklist failed: {e}', file=sys.stderr)

    # Nothing in either queue: added by hand, or the *arr is down. Delete it
    # anyway - the file is hostile either way - but be explicit that nothing
    # was taught, because this is the case that can loop.
    if dry:
        return 'Would be deleted from qBittorrent only (dry run).', None
    qb('/api/v2/torrents/stop', f'hashes={h}')
    qb('/api/v2/torrents/delete', f'hashes={h}&deleteFiles=true')
    return ('Deleted, but Sonarr/Radarr did not know this download, so it could '
            'not be blocked and may be grabbed again.'), None


def wanted_for(rows):
    """'Ted Lasso S4E10' or 'Dune (2021)' from queue rows, for a title a person can read."""
    r = rows[0]
    if r.get('series'):
        eps = sorted({(x.get('episode') or {}).get('episodeNumber') for x in rows} - {None})
        season = (r.get('episode') or {}).get('seasonNumber', r.get('seasonNumber'))
        if len(eps) == 1:
            return f"{r['series']['title']} S{season}E{eps[0]}"
        if eps:
            return f"{r['series']['title']} season {season} ({len(eps)} episodes)"
        return r['series']['title']
    if r.get('movie'):
        m = r['movie']
        return f"{m['title']} ({m['year']})" if m.get('year') else m['title']
    return None


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
            print(f'REMOVE {h} {name[:60]} -> {hostile}')
            outcome, what = remove_and_blocklist(h, dry)
            print(f'       {outcome}')
            body = (
                f"The download was a disguised program ({', '.join(hostile)}), not a video. "
                f"Nothing was opened, so nothing was harmed.\n"
                f"{outcome}\n"
                f"Release: {name}"
            )
            removed.append((what or name, body))

        elif arr and not has_media and h not in seen:
            # Reported only. Split archives are legitimate and look like this.
            print(f'FLAG   {h} {name[:60]} -> no media extension')
            flagged.append((name, (
                f"There is no video file among its {len(files)} file(s). "
                f"Usually a packed archive, which is fine, but it can be junk. "
                f"Worth a look in qBittorrent.")))
            seen.add(h)

    for what, body in removed:
        notify(f'Fake download removed: {what}', body, priority='urgent', tags='rotating_light')
    for what, body in flagged:
        notify(f'Check this download: {what}', body, priority='default', tags='mag')

    save_seen(seen & live)
    if not removed and not flagged:
        print(f'ok - {len(torrents)} torrent(s), nothing hostile')
    return 0


if __name__ == '__main__':
    sys.exit(main())
