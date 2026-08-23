#!/bin/sh
# gluetun calls this whenever ProtonVPN hands out a new forwarded port.
# Proton rotates it on every reconnect, so without this qBittorrent would keep
# announcing a port that no longer forwards and quietly stop accepting peers.
#
# 127.0.0.1 works because qBittorrent shares this container's network namespace.
# That is also why no credentials are needed: qBittorrent is set to skip auth
# for localhost, which only this namespace can be.
PORT="$1"
[ -z "$PORT" ] && exit 0

wget -qO- --post-data="json={\"listen_port\":${PORT},\"random_port\":false,\"upnp\":false}" \
  http://127.0.0.1:8083/api/v2/app/setPreferences >/dev/null 2>&1 \
  && echo "qbit listen port set to ${PORT}" \
  || echo "failed to set qbit listen port ${PORT}"
