#!/usr/bin/env bash
# Emit the relay VPS's own configuration as a tar stream on stdout.
#
# This is the forced command for the homelab's backup key: that key can run
# this and nothing else, so a compromised homelab cannot take the VPS. The
# files include wg0.conf, which holds the VPS private key - the backup they
# land in is encrypted client-side by restic before it leaves the house.
set -euo pipefail

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/relay"
mkdir -p "$OUT"

copy() {  # copy <path> - keeps the tree readable in the archive
  [ -e "$1" ] || return 0
  mkdir -p "$OUT$(dirname "$1")"
  cp -a "$1" "$OUT$1" 2>/dev/null || true
}

copy /etc/nginx/nginx.conf
copy /etc/nginx/stream-relay.conf
copy /etc/nginx/sites-available/acme-relay
copy /etc/nginx/sites-enabled
copy /etc/wireguard/wg0.conf
copy /etc/wireguard/relay.key
copy /usr/local/sbin/update-geoip
copy /etc/systemd/system/update-geoip.service
copy /etc/systemd/system/update-geoip.timer
copy /etc/sysctl.d/99-relay-forward.conf
copy /root/.ssh/authorized_keys

# State that is not in a file anywhere: the firewall and the routing rules.
{
  echo "# captured $(date -Is) on $(hostname)"
  echo "## ufw status"; ufw status verbose 2>/dev/null || true
  echo; echo "## iptables -t nat -S"; iptables -t nat -S 2>/dev/null || true
  echo; echo "## iptables -S"; iptables -S 2>/dev/null || true
  echo; echo "## ip addr"; ip -brief addr 2>/dev/null || true
  echo; echo "## wg (public keys only)"; wg show 2>/dev/null || true
  echo; echo "## os"; . /etc/os-release && echo "$PRETTY_NAME kernel $(uname -r)"
  echo; echo "## packages installed explicitly"
  apt-mark showmanual 2>/dev/null | tr '\n' ' '
} > "$OUT/runtime-state.txt" 2>/dev/null

tar -czf - -C "$TMP" relay
