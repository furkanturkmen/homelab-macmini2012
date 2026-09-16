#!/usr/bin/env bash
# Nightly offsite backup to Backblaze B2, encrypted by restic, sent through the VPN.
#
# What this backs up: the things that cannot be downloaded again - secrets,
# keys, databases, Nextcloud's files, the per-user content filters. Not the
# media library (terabytes, replaceable) and not caches, artwork or logs.
#
# Live SQLite files are snapshotted first (scripts/backup-sqlite.py) and
# MariaDB is dumped in a transaction, because copying a database while a
# service writes to it produces a file that restores into corruption.
#
# Everything leaves through gluetun's HTTP proxy, so the ISP sees VPN traffic
# rather than a nightly conversation with Backblaze. Verified by pointing the
# proxy at a closed port: restic then fails rather than falling back.
#
# Needs in .env: B2_BUCKET, B2_ACCOUNT_ID, B2_ACCOUNT_KEY, RESTIC_PASSWORD,
# MARIADB_ROOT_PASSWORD, NTFY_TOPIC. Optional: KUMA_PUSH_TOKEN.
set -euo pipefail

HOMELAB_DIR="${HOMELAB_DIR:-$HOME/homelab}"
STAGING="${BACKUP_STAGING:-$HOME/.backup-staging}"
LOG="${BACKUP_LOG:-$HOME/homelab-scripts/backup.log}"
NEXTCLOUD_DATA="${NEXTCLOUD_DATA:-/mnt/storage/documents}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:latest}"
HELPER_IMAGE="${HELPER_IMAGE:-python:3-alpine}"
# No colon: an explicitly empty BACKUP_PROXY means "no proxy", while unset
# still defaults to the VPN. With ${VAR:-default} an empty value would be
# treated as unset and silently keep proxying.
PROXY="${BACKUP_PROXY-http://gluetun:8888}"
NETWORK="${BACKUP_NETWORK:-homelab_default}"
REPO_PATH="${BACKUP_REPO_PATH:-homelab}"
RELAY_CONTAINER="${RELAY_CONTAINER:-wg-relay}"   # holds the tunnel namespace
RELAY_PEER="${RELAY_PEER:-10.77.0.1}"            # the VPS end, inside the tunnel
HELPER_IMAGE_ALPINE="${HELPER_IMAGE_ALPINE:-alpine}"
NTFY_URL="${NTFY_LOCAL_URL:-http://127.0.0.1:8095}"
KUMA_URL="${KUMA_LOCAL_URL:-http://127.0.0.1:3001}"

KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${KEEP_MONTHLY:-6}"

mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') backup starting ==="

set -a
# shellcheck disable=SC1091
. "$HOMELAB_DIR/.env"
set +a

for v in B2_BUCKET B2_ACCOUNT_ID B2_ACCOUNT_KEY RESTIC_PASSWORD; do
  [ -n "${!v:-}" ] || { echo "FATAL: $v missing from .env"; exit 1; }
done

REPO="b2:${B2_BUCKET}:${REPO_PATH}"

notify() {  # notify <title> <message> <priority>
  [ -n "${NTFY_TOPIC:-}" ] || return 0
  curl -s -o /dev/null --max-time 15 \
    -H "Title: $1" -H "Priority: ${3:-3}" -H "Tags: floppy_disk" \
    -d "$2" "$NTFY_URL/$NTFY_TOPIC" || true
}

failed() {
  local line=$1
  echo "FAILED at line $line"
  notify "Backup FAILED" "The offsite backup failed at line $line. See backup.log on the server." 5
  [ -n "${KUMA_PUSH_TOKEN:-}" ] && curl -s -o /dev/null --max-time 10 \
    "$KUMA_URL/api/push/$KUMA_PUSH_TOKEN?status=down&msg=backup%20failed" || true
  rm -rf "$STAGING"
}
trap 'failed $LINENO' ERR

rm -rf "$STAGING"
# Both exist even when empty: they are named in the include list, and restic
# fails the whole run on a path that is not there.
mkdir -p "$STAGING/db" "$STAGING/vps"
chmod 700 "$STAGING"

echo "--- dumping MariaDB (Nextcloud) ---"
docker exec -e MYSQL_PWD="$MARIADB_ROOT_PASSWORD" nextcloud-db \
  mariadb-dump --single-transaction --quick --routines -u root nextcloud \
  > "$STAGING/db/nextcloud-db.sql"
echo "  $(du -h "$STAGING/db/nextcloud-db.sql" | cut -f1) written"

echo "--- snapshotting SQLite databases ---"
docker run --rm \
  -v "$HOMELAB_DIR":/src:ro \
  -v "$STAGING/db":/out \
  -v "$HOMELAB_DIR/scripts/backup-sqlite.py":/backup-sqlite.py:ro \
  "$HELPER_IMAGE" python3 /backup-sqlite.py /src /out

# The include list is explicit rather than "everything minus excludes": a new
# service appearing must be a deliberate decision to back up, not a surprise
# either way.
cat > "$STAGING/include.txt" <<'EOF'
/staging/db
/staging/vps
/data/.env
/data/docker-compose.yml
/data/wg-relay
/data/wg-home
/data/gluetun
/data/relay
/data/npm-custom
/data/jellyfin/config/config
/data/jellyfin/config/plugins/configurations
/data/jellyfin/config/root
/data/jellyfin/config/system.xml
/data/nextcloud/html/config
/data/jellyseerr/config/settings.json
/data/jellyseerr/config/anime-list.xml
/data/sonarr/config/config.xml
/data/radarr/config/config.xml
/data/prowlarr/config/config.xml
/data/bazarr/config/config
/data/npm/data
/data/npm/letsencrypt
/data/homarr/appdata/trusted-certificates
/data/seerr-guard-data
/data/jellylab-push-data
/data/pihole/etc/pihole.toml
/data/pihole/etc/adlists.list
/data/pihole/etc/dhcp.leases
/data/pihole/etc/hosts
/data/pihole/dnsmasq
/data/dnscrypt-proxy/dnscrypt-proxy.toml
/data/decluttarr/config.yaml
/data/7dtd/saves
/documents
EOF

cat > "$STAGING/exclude.txt" <<'EOF'
*.log
*.log.*
*/logs/*
*/log/*
*/cache/*
*/Cache/*
/data/npm/data/logs
/documents/appdata_*/preview
EOF

# The relay VPS's own configuration - the SNI allowlist, its WireGuard keys,
# the country-filter units - exists nowhere else. Without this, losing that
# machine means rebuilding it from memory.
#
# Fetched over the existing tunnel rather than the VPS's public address, so no
# new connection appears for the ISP to see; the traffic is already flowing.
# The key it uses is locked to a single command on the VPS side, so a
# compromised homelab cannot take the relay with it.
if docker ps --format '{{.Names}}' | grep -qx "$RELAY_CONTAINER"; then
  echo "--- fetching the relay VPS config (through the tunnel) ---"
  mkdir -p "$STAGING/vps"
  if docker run --rm --network "container:$RELAY_CONTAINER" \
       -v "$HOME/.ssh":/ssh:ro "$HELPER_IMAGE_ALPINE" \
       sh -c "apk add -q --no-cache openssh-client && \
              ssh -i /ssh/id_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
                  -o ConnectTimeout=15 root@$RELAY_PEER" \
       > "$STAGING/vps/relay-config.tar.gz" 2>/dev/null \
     && [ -s "$STAGING/vps/relay-config.tar.gz" ]; then
    echo "  $(du -h "$STAGING/vps/relay-config.tar.gz" | cut -f1) received"
  else
    # Not fatal: the rest of the backup matters more than the relay config,
    # and a relay that is down is already being alerted on separately.
    echo "  WARNING: could not reach the relay VPS, continuing without it"
    rm -f "$STAGING/vps/relay-config.tar.gz"
    notify "Backup: relay config missing" \
      "Could not fetch the VPS config through the tunnel; the rest was backed up." 3
  fi
fi

if [ -f "$STAGING/db/INTEGRITY-WARNINGS.txt" ]; then
  echo "--- WARNING: damaged databases (backed up anyway) ---"
  cat "$STAGING/db/INTEGRITY-WARNINGS.txt"
  notify "Backup: damaged database" \
    "$(tr '\n' ' ' < "$STAGING/db/INTEGRITY-WARNINGS.txt") - backed up anyway, repair with REINDEX" 4
fi

echo "--- restic backup ---"
docker run --rm --network "$NETWORK" \
  -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY -e RESTIC_PASSWORD \
  -e HTTP_PROXY="$PROXY" -e HTTPS_PROXY="$PROXY" \
  -v "$HOMELAB_DIR":/data:ro \
  -v "$NEXTCLOUD_DATA":/documents:ro \
  -v "$STAGING":/staging:ro \
  "$RESTIC_IMAGE" -r "$REPO" backup \
    --files-from /staging/include.txt \
    --exclude-file /staging/exclude.txt \
    --host homelab --tag nightly

echo "--- pruning old snapshots ---"
docker run --rm --network "$NETWORK" \
  -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY -e RESTIC_PASSWORD \
  -e HTTP_PROXY="$PROXY" -e HTTPS_PROXY="$PROXY" \
  "$RESTIC_IMAGE" -r "$REPO" forget \
    --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" \
    --prune

# A repository that is never verified is a guess. Sunday reads back a slice of
# the actual data, which catches bit-rot that a metadata check would miss.
if [ "$(date +%u)" = "7" ]; then
  echo "--- weekly integrity check ---"
  docker run --rm --network "$NETWORK" \
    -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY -e RESTIC_PASSWORD \
    -e HTTP_PROXY="$PROXY" -e HTTPS_PROXY="$PROXY" \
    "$RESTIC_IMAGE" -r "$REPO" check --read-data-subset=5%
fi

SNAPSHOT=$(docker run --rm --network "$NETWORK" \
  -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY -e RESTIC_PASSWORD \
  -e HTTP_PROXY="$PROXY" -e HTTPS_PROXY="$PROXY" \
  "$RESTIC_IMAGE" -r "$REPO" snapshots --latest 1 --json 2>/dev/null \
  | tr ',' '\n' | grep -o '"short_id":"[^"]*"' | cut -d'"' -f4 || echo unknown)

rm -rf "$STAGING"
trap - ERR

echo "=== $(date '+%Y-%m-%d %H:%M:%S') backup finished, snapshot $SNAPSHOT ==="

# Success is reported to Kuma, not to the phone: a push every night trains you
# to ignore them, and a missed heartbeat is what actually needs an alarm.
[ -n "${KUMA_PUSH_TOKEN:-}" ] && curl -s -o /dev/null --max-time 10 \
  "$KUMA_URL/api/push/$KUMA_PUSH_TOKEN?status=up&msg=snapshot%20$SNAPSHOT" || true
