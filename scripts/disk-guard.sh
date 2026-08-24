#!/usr/bin/env bash
# Stop qBittorrent if free space on / falls below STOP_GB.
# A full root filesystem corrupts the MariaDB store backing Nextcloud,
# which is real data loss - a stalled download is not.
set -uo pipefail

STOP_GB=40
WARN_GB=80
COMPOSE_DIR="$HOME/homelab"
LOG="$HOME/homelab-scripts/disk-guard.log"

log() { printf '%s  %s\n' "$(date '+%F %T')" "$1" >> "$LOG"; }

free_gb=$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
[ -z "$free_gb" ] && { log "ERROR could not read free space"; exit 1; }

running=$(docker inspect -f '{{.State.Running}}' qbittorrent 2>/dev/null || echo false)

if [ "$free_gb" -lt "$STOP_GB" ]; then
  if [ "$running" = "true" ]; then
    log "CRITICAL ${free_gb}GB free (< ${STOP_GB}GB) - stopping qbittorrent"
    cd "$COMPOSE_DIR" && docker compose stop qbittorrent >> "$LOG" 2>&1
    log "qbittorrent stopped - restart manually once space is freed"
  fi
elif [ "$free_gb" -lt "$WARN_GB" ]; then
  log "WARN ${free_gb}GB free (< ${WARN_GB}GB)"
fi

# Usage history, so a replacement drive can be sized from real numbers
# instead of extrapolating a one-off import burst into a weekly rate.
printf '%s,%s\n' "$(date '+%F %T')" "$free_gb" >> "$HOME/homelab-scripts/disk-usage.csv"
