# Phase 13 — Offsite backups

Everything so far lives on one disk in one flat. A drive failure, a theft or a
fire takes the lot: Nextcloud's files, every request and watch history, the
monitors, the certificates, the per-user filters, and the keys that make the
relay work. The media is the one part that does not matter — it can be
downloaded again.

This phase copies the irreplaceable parts to Backblaze B2 every night,
encrypted before they leave the house, through the VPN.

> Sending it through the VPN assumes gluetun from [Phase 7](07-qbittorrent-vpn.md).
> Without it the backup works exactly the same — drop the two `HTTPS_PROXY` /
> `HTTP_PROXY` lines (or set `BACKUP_PROXY=`) and restic talks to Backblaze
> directly. The only difference is that your ISP can then see you back up to
> Backblaze nightly, never what is in it. Nothing here needs
> [Phase 10](10-public-relay.md).

```
sqlite snapshots + mysqldump ──┐
config, keys, .env            ─┼─▶ restic (encrypts) ─▶ gluetun (VPN) ─▶ Backblaze B2
Nextcloud's files             ─┘
```

## What is backed up, and what is not

| Backed up | Why |
|---|---|
| `.env`, `wg-relay/`, `wg-home/`, `gluetun/` | secrets and private keys — nothing can regenerate these |
| Every service database (SQLite) + Nextcloud's MariaDB | users, history, requests, monitors, filters |
| npm's data **and** `letsencrypt/` | proxy hosts and the certificates |
| `jellylab-push-data/`, `seerr-guard-data/` | the per-user content filters ([Phase 12](12-content-filters.md)) |
| Pi-hole's `pihole.toml`, adlists, local records | the DNS setup, minus its query history |
| Nextcloud's data directory | the actual files people put there |
| Game saves | small, and genuinely lost otherwise |

| Left out | Size here | Why |
|---|---|---|
| The media library | 1.2 TB | downloadable again; backing it up would cost more than the server |
| Jellyfin `cache/`, `trickplay/`, `subtitles/`, `metadata/` | 7 GB | regenerated on demand |
| `MediaCover/`, artwork | 139 MB | re-fetched from the metadata providers |
| Logs | ~850 MB | noise |
| Pi-hole's `pihole-FTL.db` | 80 MB+ | query history, not configuration |
| Nextcloud's `html/` | 820 MB | that is the application, it comes from the image |

Here that comes to **~600 MB**, which restic compresses to about **140 MB
stored**. B2's free tier is 10 GB, so the running cost is nothing.

The include list in `scripts/backup.sh` is **explicit**, not "everything except
excludes". A new service appearing must be a deliberate decision to back up —
the alternative silently backs up junk, or silently misses something that
matters.

## Step 13.1 — The Backblaze side

1. An account at backblaze.com → B2 Cloud Storage. Use a **mail alias**, not
   your main address, and turn on 2FA.
2. A **private** bucket. The name is globally unique and semi-public, so make it
   meaningless — a word plus random hex, never `yourname-backup`:

   ```bash
   python3 -c "import secrets; print('vault-' + secrets.token_hex(3))"
   ```
3. **Application Keys → Add a New Application Key**, restricted to *that bucket
   only*, Read and Write, no expiry. A key with a duration silently breaks
   backups the day it lapses.

   > The next screen is the only time the secret is shown. The keys list
   > afterwards shows the key's **name** and its **keyID** — never the secret.
   > Copying from that list gets you the name, and authentication fails with
   > `bad_auth_token`. The `keyID` is 25 characters; the `applicationKey` is 31
   > and starts with `K`.

4. Invent the repository password — it is not given to you by anyone:

   ```bash
   head -c 24 /dev/urandom | base64
   ```

   **Store it somewhere that is not this server**, in a password manager and on
   paper. restic encrypts client-side: lose this and the backups are
   permanently unreadable, by you and by Backblaze. It is the one value here
   with no reset link.

Add to `.env`:

```
B2_BUCKET=yourbucket
B2_ACCOUNT_ID=<the 25-char keyID>
B2_ACCOUNT_KEY=<the 31-char applicationKey>
RESTIC_PASSWORD=<what you just generated>
```

Check the credentials before building anything on them:

```bash
curl -s -u "$B2_ACCOUNT_ID:$B2_ACCOUNT_KEY" \
  https://api.backblazeb2.com/b2api/v3/b2_authorize_account | head -c 400
# capabilities should include listFiles, readFiles, writeFiles, deleteFiles
# and bucketName should be your bucket - proof the key is scoped, not global
```

## Step 13.2 — Create the repository, through the VPN

```bash
cd ~/homelab && set -a && . ./.env && set +a
docker run --rm --network homelab_default \
  -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY -e RESTIC_PASSWORD \
  -e HTTPS_PROXY=http://gluetun:8888 -e HTTP_PROXY=http://gluetun:8888 \
  restic/restic:latest -r "b2:$B2_BUCKET:homelab" init
```

restic runs as a container, so nothing is installed on the host and it updates
like any other image. It runs as root inside that container, which is what lets
it read the service files that belong to root.

**Prove the VPN is actually used** rather than assuming it, by pointing the
proxy at a closed port. restic must *fail*:

```bash
docker run --rm --network homelab_default ... -e HTTPS_PROXY=http://gluetun:9999 \
  restic/restic:latest -r "b2:$B2_BUCKET:homelab" snapshots
# Fatal: proxyconnect tcp: ... connect: connection refused   <- correct
```

If it succeeds with a dead proxy, the traffic is not going through the VPN.
(Radarr and Sonarr behave exactly that way with their own proxy setting —
see [Release rules](release-rules.md).)

## Step 13.3 — The script

[`scripts/backup.sh`](../scripts/backup.sh), run nightly from cron:

```
30 3 * * * /bin/bash /home/youruser/homelab/scripts/backup.sh >/dev/null 2>&1
```

It does four things in order:

1. **Dumps MariaDB** with `--single-transaction`, so the dump is consistent
   without locking Nextcloud out.
2. **Snapshots every SQLite database** via
   [`scripts/backup-sqlite.py`](../scripts/backup-sqlite.py), using SQLite's
   backup API. **Copying a live SQLite file with `cp` can capture a half-written
   page**, and you find out at restore time. Each copy is then verified with
   `PRAGMA integrity_check`.
3. **Runs restic** over the staged copies plus the explicit include list.
4. **Forgets and prunes** on a `7 daily / 4 weekly / 6 monthly` schedule, and on
   Sundays runs `check --read-data-subset=5%`, which reads real data back and so
   catches bit-rot that a metadata check would miss.

A damaged database is **backed up anyway** and raises a push notification. A
copy that restores partially beats no copy at all, and the alarm is what gets it
repaired. On the very first run here, that check found a genuine fault —
`row 896 missing from index sqlite_autoindex_PeopleBaseItemMap_1` in Jellyfin's
live database, plausibly from an earlier kernel crash. Repaired with the service
stopped:

```bash
docker stop jellyfin
docker run --rm -v ~/homelab/jellyfin/config/data:/d python:3-alpine python3 -c \
  "import sqlite3; c=sqlite3.connect('/d/jellyfin.db'); c.execute('REINDEX PeopleBaseItemMap'); c.commit(); print(c.execute('PRAGMA integrity_check').fetchone())"
docker start jellyfin
```

`REINDEX` rebuilds an index from the table data. If the table itself held
duplicates it would refuse — which is the signal to stop and look, not to force.

## Step 13.4 — Alert on a backup that stops happening

The dangerous failure is not a loud one, it is silence. A **push** monitor in
Uptime Kuma covers that: the script pings it on success, and Kuma alerts when
the ping stops.

- Type **Push**, interval **93600** seconds (26 hours — one missed nightly run
  alerts, without false alarms from normal drift)
- Attach the ntfy notification from [Phase 6](06-push-notifications.md)
- Put the token in `.env` as `KUMA_PUSH_TOKEN`

Success is deliberately **not** pushed to the phone. A notification every night
is one you learn to ignore.

## Step 13.5 — Restore, which is the only thing that matters

Run this at least once, now, and again whenever the include list changes.

```bash
cd ~/homelab && set -a && . ./.env && set +a
mkdir -p ~/restore-test
docker run --rm --network homelab_default \
  -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY -e RESTIC_PASSWORD \
  -e HTTPS_PROXY=http://gluetun:8888 \
  -v ~/restore-test:/restore \
  restic/restic:latest -r "b2:$B2_BUCKET:homelab" restore latest --target /restore
```

Then check the restored databases really open:

```bash
docker run --rm -v ~/restore-test/staging/db:/r python:3-alpine python3 -c "
import sqlite3, glob, os
for p in sorted(glob.glob('/r/*.db')):
    con = sqlite3.connect(p)
    print(os.path.basename(p), con.execute('PRAGMA integrity_check').fetchone()[0])"
```

> **Mount that directory read-write for the check.** Most of these databases are
> in WAL mode, and SQLite cannot open a WAL database from a read-only mount —
> it needs to create `-wal`/`-shm` beside it. Testing with `:ro` reports
> `unable to open database file` for every WAL database and looks exactly like
> a corrupt backup. It is not.

And confirm a file survived byte for byte:

```bash
sha256sum ~/homelab/.env
sudo sha256sum ~/restore-test/data/.env      # must match
```

### Restoring on a machine that no longer exists

The point of this phase. On any machine with Docker:

```bash
export B2_ACCOUNT_ID=... B2_ACCOUNT_KEY=... RESTIC_PASSWORD=...
docker run --rm -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY -e RESTIC_PASSWORD \
  -v "$PWD/restore":/restore restic/restic:latest \
  -r b2:yourbucket:homelab snapshots

docker run --rm ... restic/restic:latest -r b2:yourbucket:homelab \
  restore latest --target /restore
```

Then: put `.env` back, `git clone` the repo, copy the databases into place with
the services stopped, `docker compose up -d`, and load the MariaDB dump with
`mariadb -u root -p nextcloud < nextcloud-db.sql`.

Keep that sequence in the same password-manager note as the keys. In the
situation where you need it, this server is not available to look things up on.

---

[← Phase 12: Optional: per-user content filters](12-content-filters.md) · [All phases](README.md)
