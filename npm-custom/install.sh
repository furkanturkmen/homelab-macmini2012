#!/usr/bin/env bash
# Render http.conf and server_proxy.conf from .env and load them into NPM.
#
# The files are templates: ${LAN_DOMAIN} and friends are filled in here, and
# only those names - nginx's own $host, $http_origin and the rest pass through
# untouched because envsubst is given an explicit list.
#
#   npm-custom/install.sh           render, install, test, reload
#   npm-custom/install.sh --print   render to stdout only, change nothing
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOMELAB_DIR="${HOMELAB_DIR:-$(dirname "$HERE")}"
CONTAINER="${NPM_CONTAINER:-npm}"

REQUIRED='LAN_DOMAIN PUBLIC_JELLYFIN_HOST'
# The JellyLab dev server is a convenience; without one the block points at
# nothing and stays harmless.
: "${JELLYLAB_DEV_HOST:=}" "${JELLYLAB_DEV_PORT:=}"

from_env() { sed -n "s/^$1=//p" "$HOMELAB_DIR/.env" 2>/dev/null | tail -1 | tr -d "\"'"; }

for v in $REQUIRED JELLYLAB_DEV_HOST JELLYLAB_DEV_PORT; do
  [ -n "${!v:-}" ] || export "$v=$(from_env "$v")"
done
for v in $REQUIRED; do
  [ -n "${!v:-}" ] || { echo "$v is not set: add it to $HOMELAB_DIR/.env" >&2; exit 1; }
done
export JELLYLAB_DEV_HOST="${JELLYLAB_DEV_HOST:-127.0.0.1}"
export JELLYLAB_DEV_PORT="${JELLYLAB_DEV_PORT:-8082}"

list='${LAN_DOMAIN} ${PUBLIC_JELLYFIN_HOST} ${JELLYLAB_DEV_HOST} ${JELLYLAB_DEV_PORT}'

if [ "${1:-}" = "--print" ]; then
  for f in http.conf server_proxy.conf; do
    echo "# ---- $f"
    envsubst "$list" < "$HERE/$f"
  done
  exit 0
fi

docker exec "$CONTAINER" mkdir -p /data/nginx/custom
for f in http.conf server_proxy.conf; do
  envsubst "$list" < "$HERE/$f" | docker exec -i "$CONTAINER" sh -c "cat > /data/nginx/custom/$f"
done
docker exec "$CONTAINER" nginx -t && docker exec "$CONTAINER" nginx -s reload
echo "installed and reloaded"
