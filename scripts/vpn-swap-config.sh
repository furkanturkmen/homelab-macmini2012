#!/usr/bin/env bash
# Move gluetun onto a new Proton WireGuard config.
#
# For when the Proton server in .env stops answering (vpn-guard says so): the
# key may still be valid, but the config names one server and that one is gone.
# Download a new config for another server - GNU/Linux, NetShield off, NAT-PMP
# on, a P2P server - copy it to this machine and run:
#
#   scripts/vpn-swap-config.sh ~/proton.conf
#
# It backs up .env, writes the five WireGuard values without printing the key,
# recreates gluetun, then *recreates* (not restarts) everything sharing its
# network namespace - a restart fails with "joining network namespace of
# container: No such container" once gluetun is a new container - and pushes
# the forwarded port into qBittorrent. The .conf is deleted at the end; its key
# lives in .env from then on.
set -euo pipefail

CONF="${1:?usage: $0 <proton-wireguard.conf>}"
HOMELAB_DIR="${HOMELAB_DIR:-$HOME/homelab}"
ENV_FILE="$HOMELAB_DIR/.env"
PEERS="${VPN_PEERS:-qbittorrent prowlarr flaresolverr}"

get() { sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" "$CONF" | head -1 | tr -d '\r'; }
PK=$(get PrivateKey); PUB=$(get PublicKey); ADDR=$(get Address); EP=$(get Endpoint)
for v in PK PUB ADDR EP; do
  [ -n "${!v}" ] || { echo "$CONF has no ${v} line - is it a WireGuard config?" >&2; exit 1; }
done
ADDR="${ADDR%%,*}"   # IPv4 only; the tunnel does not use IPv6

backup="$ENV_FILE.bak-$(date +%F-%H%M%S)"
cp -p "$ENV_FILE" "$backup"
setv() {
  if grep -q "^$1=" "$ENV_FILE"; then
    # | as the delimiter: base64 keys contain / and +, never |
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
setv WIREGUARD_PRIVATE_KEY "$PK"
setv WIREGUARD_PUBLIC_KEY "$PUB"
setv WIREGUARD_ADDRESSES "$ADDR"
setv VPN_ENDPOINT_IP "${EP%:*}"
setv VPN_ENDPOINT_PORT "${EP##*:}"
echo ".env updated (backup: $backup), server ${EP%:*}"

cd "$HOMELAB_DIR"
docker compose up -d gluetun
printf 'waiting for gluetun'
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' gluetun)" = healthy ] && break
  printf '.'; sleep 5
done
echo
if [ "$(docker inspect -f '{{.State.Health.Status}}' gluetun)" != healthy ]; then
  echo "gluetun is not healthy after 150s - this server does not answer either." >&2
  echo "Try a config for another server; the old values are in $backup." >&2
  exit 1
fi

# shellcheck disable=SC2086
docker compose up -d --force-recreate --no-deps $PEERS
for _ in $(seq 1 24); do
  docker exec gluetun wget -qO- -T5 http://127.0.0.1:8083/api/v2/app/version >/dev/null 2>&1 && break
  sleep 5
done
port=$(docker exec gluetun cat /tmp/gluetun/forwarded_port 2>/dev/null || true)
if [ -n "$port" ]; then
  docker exec gluetun /gluetun/update-qbit-port.sh "$port"
else
  echo "no forwarded port - was NAT-PMP switched on for this config?" >&2
fi

rm -f "$CONF"
echo "done. Exit: $(docker exec gluetun wget -qO- -T10 https://1.1.1.1/cdn-cgi/trace | sed -n 's/^ip=//p')"
