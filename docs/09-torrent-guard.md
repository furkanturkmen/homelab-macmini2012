# Phase 9 — Catch a torrent that is not what it claims to be

Sonarr was filling gaps in a series and grabbed this:

```
House.of.the.Dragon.S03E05.ITA.ENG.1080p.AMZN.WEB-DL.DDP5.1.H.264 MeM.GP.mkv
```

Inside was one file: `0088F5556SE1B9348AXW1EVFFDABCA25D3XXQB03R.exe`, 837 MB,
padded to the size of a video.

```bash
file /mnt/media/downloads/*.exe
# PE32+ executable for MS Windows 5.02 (GUI), x86-64 (stripped to external PDB)
```

It reached 100% and started seeding before anyone looked. On a Linux host a
Windows binary cannot run, so nothing was infected — but the box was
redistributing malware, and the file was one copy away from a Windows machine.

## Why nothing upstream can stop this

Sonarr and Prowlarr only ever see a release *title*. That title was completely
plausible; there is no naming rule that rejects it without also rejecting real
grabs. The tells are only suggestive - it ends in `.mkv`, which real release
names do not, it claims two audio languages, and it has no release group - and
1337x legitimately uses filenames as titles, so a `\.mkv$` rule would throw
away good releases too.

The first moment the truth is knowable is when the torrent's metadata resolves
and the client can list the files inside. That is the only place worth checking.

## Step 9.1 — Demote the indexer that served it

```bash
PK=$(grep -oP '(?<=<ApiKey>)[^<]+' ~/homelab/prowlarr/config/config.xml)
curl -s -H "X-Api-Key: $PK" http://localhost:9696/api/v1/indexer \
  | python3 -c "import sys,json; [print(i['priority'], i['name']) for i in json.load(sys.stdin)]"
```

1337x was on priority 10 — joint-highest, so it was tried first for everything.
It is on 45 now: kept, but only reached when nothing else has the release. This
is the second public indexer to do this; LimeTorrents was disabled in [Phase 4](04-deploy-the-stack.md)
for the same reason.

Check that the change actually arrived. Prowlarr pushes indexer settings to
Sonarr and Radarr on its own schedule, and only when the application's Sync
Level is **Full Sync** — on *Add and Remove Only* it will never update an
indexer that already exists downstream, so the new priority silently stays in
Prowlarr:

```bash
curl -s -H "X-Api-Key: $PK" http://localhost:9696/api/v1/applications \
  | python3 -c "import sys,json; [print(a['name'], a['syncLevel']) for a in json.load(sys.stdin)]"
curl -s -X POST -H "X-Api-Key: $PK" http://localhost:9696/api/v1/command \
  -d '{"name":"ApplicationIndexerSync"}' -H 'Content-Type: application/json'
```

## Step 9.2 — The guard

`~/homelab-scripts/torrent-guard.py`, every minute from cron. It lists the files
inside every torrent qBittorrent holds and applies one narrow test:

| finding | in an *arr category | action |
|---|---|---|
| executable extension (`.exe`, `.scr`, `.bat`, `.msi`, `.lnk`, …) | yes | stop, delete with files, ntfy at urgent |
| no video extension at all | yes | ntfy only, once per torrent |
| anything | no (hand-added) | left alone |

Only the first case deletes. "No media file" is reported and never acted on,
because scene releases legitimately ship as split `.rar` volumes with no video
extension anywhere, and a false positive there destroys something real.
Hand-added torrents are exempt entirely — deleting someone's deliberate
download because it contains an installer would be its own kind of bug.

Every minute, not every five: metadata resolves within seconds of a grab, and
this payload finished in about two minutes at 48 MB/s. A slower poll arrives
after the seeding has already happened.

## Step 9.3 — Prove it before trusting it

A guard that deletes things has to be tested somewhere that is not your library.
`torrent-guard.py --dry-run` prints verdicts and touches nothing. Better, feed
it synthetic file lists and check both directions — that it removes the payload
*and* leaves real releases alone:

```
tonight's malware                        expected=REMOVE  got=REMOVE
real episode                             expected=ok      got=ok
video plus a bundled installer           expected=REMOVE  got=REMOVE
scene split archive, no video extension  expected=FLAG    got=FLAG
exe in a hand-added torrent              expected=ok      got=ok
```

## Step 9.4 — Clean up after one that got through

```bash
# stop it first - qBittorrent 5.x renamed pause to stop, and pause silently
# does nothing on this version
H=<hash>
docker exec gluetun wget -qO- --post-data="hashes=$H" http://127.0.0.1:8083/api/v2/torrents/stop
docker exec gluetun wget -qO- --post-data="hashes=$H&deleteFiles=true" http://127.0.0.1:8083/api/v2/torrents/delete
```

Then blocklist it in Sonarr, or it will be grabbed again on the next search.
Find the grab in history and mark it failed:

```bash
SK=$(grep -oP '(?<=<ApiKey>)[^<]+' ~/homelab/sonarr/config/config.xml)
curl -s -H "X-Api-Key: $SK" 'http://localhost:8989/api/v3/history?pageSize=40&sortKey=date&sortDirection=descending' \
  | python3 -c "import sys,json; [print(h['id'], h['sourceTitle']) for h in json.load(sys.stdin)['records'] if h['eventType']=='grabbed']"
curl -s -X POST -H "X-Api-Key: $SK" http://localhost:8989/api/v3/history/failed/<id>
```

## Step 9.5 — Clear what is going nowhere: decluttarr

The guard catches a torrent that is *hostile*. A torrent that is merely *dead*
is a different problem, and Sonarr and Radarr have no answer to it at all: they
wait forever. Two of them sat in the queue for hours before anyone looked:

- **Chainsaw Man:** a "Bluray x264 CUSTOM MULTi" season pack stuck at
  *qBittorrent is downloading metadata* for 6¾ hours. The trackers claimed
  10-14 seeders; not one ever connected.
- **Attack on Titan:** a season pack at 86% and 0 B/s. Forty peers were
  connected, and between them they held exactly 86% of it. No complete copy
  existed in the swarm.

[decluttarr](https://github.com/ManiMatter/decluttarr) checks the queues every
10 minutes. When a download is caught several times in a row it removes it from
qBittorrent, blocklists that release in Sonarr or Radarr, and has them search
for another. It runs as the `decluttarr` service in `docker-compose.yml`, with
[`decluttarr/config.yaml`](../decluttarr/config.yaml) mounted read-only. The API
keys and the qBittorrent login come from `.env` through `!ENV`, so the config
file holds no secrets.

What is switched on, and why each is tuned the way it is:

| Job | Acts after | Notes |
|---|---|---|
| `remove_metadata_missing` | 30 min | dead or fake magnets, the Chainsaw Man case |
| `remove_stalled` | 30 min | no connections at all |
| `remove_slow` | 1 hour below 50 KB/s | tolerant on purpose: old anime can be slow and healthy, and a blocklisted slow release may be the only one there is. Skipped while qBittorrent uses most of its global download limit |
| `remove_failed_downloads` | at once | |
| `remove_failed_imports` | at once | only messages that never resolve: dangerous file, invalid video, nothing importable, not an upgrade |

Deliberately off: `search_unmet_cutoff` (it chases "better" releases, the
opposite of Phase 8), `remove_bad_files` (it rewrites which files in a torrent
download; the guard above already handles executables), `remove_unmonitored`
(multi-season packs trip it).

**Also off, after they did more harm than good on the first day:**

- **`remove_orphans`.** An orphan is a download no Sonarr or Radarr title
  claims. Right after a restart, Sonarr's queue is briefly empty, and on this
  server the containers also could not see the media disk for a while (see
  getting-help). In that window it took five live Better Call Saul downloads
  for orphans and removed them. Nothing was blocklisted and the library was
  untouched (Sonarr imports with hardlinks), but the progress was lost.
- **`search_missing`.** It searches episode by episode. For an older series that
  makes Sonarr grab single-episode torrents, which are mostly dead, while season
  packs have seeders. The dead ones took all three download slots and queued
  everything else behind them. For a series that is missing whole seasons, run
  **Series → Search Season** in Sonarr instead: a season search picks a pack.

Tag a torrent `Keep` in qBittorrent and decluttarr never touches it.

Start with `test_run: true` and read the log for a few rounds:

```bash
docker compose up -d decluttarr
docker logs -f decluttarr        # also written to decluttarr/logs/logs.txt
```

Two things to know about test mode. With `search_missing` on, it still starts
those searches, so it is not entirely passive. And on start it warns that
`detect_deletions` cannot see the media paths, although that job is not
enabled; the warning is harmless.

On this server test mode ran for two rounds, flagged nothing (nothing in the
queue was stuck by then), and was then switched off. There is no ntfy
notification from decluttarr; what it removed shows in Sonarr and Radarr under
**Activity → Blocklist** and in its log.

---

[← Phase 8: Stop the server transcoding: prefer H.264 at grab time](08-prefer-h264.md) · [All phases](README.md) · [Phase 10: Optional: public links for friends, through a relay VPS →](10-public-relay.md)
