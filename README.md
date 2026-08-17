# homelab-macmini2012

Docker-based homelab on Mac Mini 2012 running Ubuntu Server. Pi-hole, Nextcloud, Jellyfin, game server (7 Days to Die), Portainer, Uptime Kuma, NPM.

## Hardware

- Mac Mini (Late 2012)
- Intel Core i7 (Ivy Bridge, 2C/4T)
- 16 GB DDR3 RAM (max)
- HDD → SSD swap planned (Crucial MX500 / Samsung 870 EVO)
- Gigabit Ethernet (Broadcom wifi/BT unused)

## OS

Ubuntu Server 24.04 LTS. Headless. SSH-managed from Windows workstation.

## Stack

| Category | Service | Port | Purpose |
|----------|---------|------|---------|
| Network | Pi-hole | 8080 | DNS ad-block |
| Network | Nginx Proxy Manager | 80 / 443 / 81 | Reverse proxy + SSL |
| Network | Tailscale (host) | — | Zero-config VPN |
| Admin | Portainer | 9000 / 9443 | Docker web UI |
| Admin | Uptime Kuma | 3001 | Service monitoring |
| Admin | Watchtower | — | Auto-update containers |
| Files | Nextcloud | 8081 | Cloud drive / calendar / contacts |
| Files | MariaDB | — | Nextcloud database |
| Files | Redis | — | Nextcloud cache |
| Media | Jellyfin | 8096 | Self-hosted media streaming |

## Quick start

Assumes Ubuntu Server installed with Docker + user in `docker` group.

```bash
git clone https://github.com/furkanturkmen/homelab-macmini2012.git
cd homelab-macmini2012
# Edit docker-compose.yml — replace passwords, FTLCONF_LOCAL_IPV4, timezone, media path
docker compose up -d
```

Then set router DNS to point at Mac Mini IP so Pi-hole handles LAN DNS.

## Access URLs

Replace `<ip>` with Mac Mini LAN IP.

| Service | URL |
|---------|-----|
| Pi-hole | `http://<ip>:8080/admin` |
| Portainer | `http://<ip>:9000` |
| Uptime Kuma | `http://<ip>:3001` |
| NPM | `http://<ip>:81` |
| Nextcloud | `http://<ip>:8081` |
| Jellyfin | `http://<ip>:8096` |
| 7DTD web | `http://<ip>:8082` |

## Setup phases

Full walkthrough in [TODO.md](TODO.md).

1. Install Ubuntu Server on Mac Mini
2. SSH access + Docker install
3. Deploy stack via docker-compose
4. Tailscale for remote access
5. Game server tuning
6. SSD hardware upgrade (planned)

## Notes

- Mac Mini 2012 Broadcom wifi/BT skipped — ethernet only
- Ivy Bridge HD 4000 = no realistic hardware transcode (Jellyfin direct-play)
- 16 GB RAM ceiling: don't run all heavy services simultaneously
- Runtime data folders in `.gitignore` (containers write locally, not tracked)

## License

Personal project, no license set.
