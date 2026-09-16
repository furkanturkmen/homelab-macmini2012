# homelab-macmini2012

Turning an old Mac Mini into a personal server for files, media, and network tools — a "homelab." This repo has all the configuration you need to build the same thing.

---

## What is a homelab?

A homelab is just a computer at home that runs services for you instead of paying big companies for them. Think:

- **Your own Google Drive** (Nextcloud) — files sync across devices, no monthly fee
- **Your own Netflix** (Jellyfin + Radarr + Sonarr) — stream movies and shows, request new ones from a friendly UI
- **Network-wide ad blocker** (Pi-hole) — blocks ads on every device on your wifi
- **Remote access from anywhere** (Netbird) — reach your server from your phone anywhere in the world, over an encrypted mesh VPN

You get privacy, save money over time, and learn a ton.

---

## What is this project?

A single Mac Mini from 2012 running a stack of 20 services. Everything is defined in `docker-compose.yml`. You install one thing (Docker), tell it "read this file," and it downloads and runs every service automatically.

Total setup time from a fresh computer: **about 2-3 hours**.

---

## The hardware

- **Mac mini (Late 2012)** — Apple model A1347, [identifier Macmini6,2](https://support.apple.com/en-us/111926)
- **Intel Core i7-3615QM** — 2.3 GHz, 4 cores, 8 threads, 6 MB L3 cache (Ivy Bridge)
- **Intel HD Graphics 4000** — integrated GPU. Does H.264 hardware transcoding via VA-API (Quick Sync). No HEVC, VP9 or AV1 support.
  This is a hard limit of the silicon, not a setting, and it decides what the library should hold: an HEVC or AV1 file has to be
  decoded in software before it can be re-encoded for a client, which this CPU cannot sustain in realtime. See
  [Phase 8](docs/08-prefer-h264.md) for how the *arr apps are told to prefer H.264, and what that looks like when they are not.
- **16 GB DDR3-1600 RAM** — maximum this model supports, cannot upgrade
- **Crucial MX100 512 GB SATA SSD** — the boot disk. If your Mac Mini is still on its stock 5400 rpm HDD, swapping in an SSD is the single biggest speed difference you can make on this machine — do it before installing Ubuntu, not after.
- **Gigabit Ethernet** — always used (Broadcom wifi and Bluetooth skipped, driver support on Linux is poor)

---

## The operating system

**Ubuntu Server 26.04 LTS** — free, popular, well-documented Linux system with no desktop (no windows, no mouse). You control it entirely by typing commands, either from the Mac Mini's keyboard OR remotely from another computer over the network (called "SSH").

The Mac Mini's original macOS gets completely erased. That is on purpose.

---

## What is Docker?

Docker runs applications in isolated boxes called "containers." Each service (Jellyfin, Nextcloud, etc.) lives in its own container so they can't mess up each other or your system. If you don't like a service, delete the container — nothing left behind.

**`docker-compose.yml`** is a recipe file that describes every container: which app, which port to open, which folder to save data to. One command (`docker compose up -d`) reads the recipe and starts everything.

---

## Services running on this homelab

Each service listens on a "port" (like a channel number on the server). You reach them either by IP + port (`http://<mac-mini-ip>:<port>`) or via a friendly hostname through Nginx Proxy Manager (`http://<service>.yourdomain.internal`) once DNS is set up.

> **`yourdomain` is a placeholder.** Pick any name you like and use it consistently in Pi-hole and NPM — `home.internal`, `lab.internal`, whatever. Nothing in `docker-compose.yml` depends on it; it only exists in the Pi-hole DNS records and the NPM proxy hosts you create by hand.

### Network
- **Pi-hole** — network-wide ad blocker + local DNS. Serves records for `*.yourdomain.internal`. Port `8080` for admin.
- **Nginx Proxy Manager (NPM)** — reverse proxy that turns `jellyfin.yourdomain.internal` into `http://jellyfin:8096` behind the scenes. Port `81` for admin.
- **Netbird** — free WireGuard-based mesh VPN. Reach your homelab from anywhere. Installed on the host, not in Docker.
- **gluetun** — WireGuard tunnel that qBittorrent runs inside, so torrent traffic leaves via ProtonVPN instead of your home connection. Everything else keeps the normal route.
- **dnscrypt-proxy** — sits behind Pi-hole and sends its lookups encrypted (DNS over HTTPS) to Quad9, so the ISP cannot read which domains the household looks up. Port `5053` on the LAN IP.
- **ntfy** — self-hosted push notifications. Radarr/Sonarr ping it on import, Seerr on request events. Port `8095`.
- **jellylab-push** — bridges ntfy events into native notifications for the companion iOS app. Port `8099`. Built and working, but parked: Apple only grants the push entitlement to paid Developer Program accounts.

### Admin
- **Portainer** — web UI showing every container, click to start/stop/restart. Port `9000`.
- **Uptime Kuma** — checks each service every minute, including real DNS lookups against Pi-hole, and pushes an alert through ntfy if one dies. Port `3001`.
- **Homarr** — the dashboard you actually open first: one tile per service, plus widgets pulled from their APIs. Port `7575`.
- **Watchtower** — quietly updates containers to their latest version every night at 4 AM. No web UI.

### Files
- **Nextcloud** — your own Google Drive / iCloud replacement. Files, calendar, contacts, sync between phone and laptop. Port `8081`.
- **MariaDB** + **Redis** — database and cache Nextcloud depends on. No UI, run in the background.

### Media (Jellyfin + *arr pipeline)
- **Jellyfin** — media server. Streams movies, TV, anime to any device. Port `8096`.
- **Radarr** — movie library manager. Tracks what you have + fetches missing releases. Port `7878`.
- **Sonarr** — same but for TV and anime. Port `8989`.
- **Bazarr** — auto-downloads subtitles + syncs them to the audio track. Port `6767`.
- **Prowlarr** — one place to configure indexers (torrent trackers, Usenet). Feeds Radarr + Sonarr. Port `9696`.
- **qBittorrent** — download client that Radarr/Sonarr hand jobs to. Port `8083`.
- **FlareSolverr** — proxy that solves Cloudflare challenges for indexers that require it. Port `8191`.
- **Jellyseerr** (stock Seerr) — request UI for friends/family. They log in with their Jellyfin account, search for a title, click Request → Radarr/Sonarr grabs it → shows up in Jellyfin. Reached through seerr-guard on port `5055`.
- **seerr-guard** — sits in front of Seerr. With per-user content filters set up, it hides titles by TMDB keyword per person, and jellylab-push makes Jellyfin hide the same titles. Without filters it is a plain proxy. Port `5055`.

---

## Full stack table

| Category | Service | Port | What it does |
|----------|---------|------|--------------|
| Network | Pi-hole | 8080 | Ad blocker + local DNS |
| Network | Nginx Proxy Manager | 80 / 443 / 81 | Reverse proxy + HTTPS |
| Network | Netbird (on host) | — | Mesh VPN for remote access |
| Network | wg-relay + relay-forward (optional) | — | Tunnel to a relay VPS for public links, off unless `COMPOSE_PROFILES=relay` |
| Network | dnscrypt-proxy | 5053 | Encrypted upstream DNS for Pi-hole |
| Network | gluetun | 8083 | VPN tunnel qBittorrent runs inside |
| Network | ntfy | 8095 | Self-hosted push notifications |
| Network | jellylab-push | 8099 | ntfy to iOS app push bridge |
| Admin | Portainer | 9000 / 9443 | Docker web UI |
| Admin | Uptime Kuma | 3001 | Service monitor |
| Admin | Homarr | 7575 | Dashboard / start page |
| Admin | Watchtower | — | Auto-updater |
| Files | Nextcloud | 8081 | Cloud drive |
| Files | MariaDB | — | Nextcloud database |
| Files | Redis | — | Nextcloud cache |
| Media | Jellyfin | 8096 | Media streaming |
| Media | Radarr | 7878 | Movie manager |
| Media | Sonarr | 8989 | TV / anime manager |
| Media | Bazarr | 6767 | Subtitle auto-download |
| Media | Prowlarr | 9696 | Indexer aggregator |
| Media | qBittorrent | (via gluetun) | Torrent client, no network of its own |
| Media | FlareSolverr | 8191 | Cloudflare challenge solver |
| Media | Jellyseerr (stock Seerr) | — | Request UI, reached through seerr-guard |
| Media | seerr-guard | 5055 | Per-user content filter in front of Seerr |

---

## How to set this up on your own machine

**The full step-by-step walkthrough is in [`docs/`](docs/README.md), one file per phase.** Work through them in order.

Quick summary if you already know what you're doing:

```bash
# 1. Install Ubuntu Server 26.04 on your machine
# 2. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out and back in

# 3. Clone this repo
git clone https://github.com/furkanturkmen/homelab-macmini2012.git
cd homelab-macmini2012

# 4. Create your .env from the template — never commit real secrets
cp .env.example .env
nano .env    # set HOST_LAN_IP, timezone, passwords

# 5. Start everything
docker compose up -d
```

The `.env` file is **gitignored** — your real passwords never leave your machine. The compose file only references `${VAR}` placeholders that get filled in from `.env` at runtime.

---

## Things to know before you start

- **The Mac Mini becomes headless** — no monitor, no keyboard once set up. You control it from your laptop via SSH.
- **Broadcom wifi and Bluetooth don't work well on Linux** for this model. Use Ethernet only.
- **Hardware transcoding works, but H.264 only.** The HD 4000 does H.264 decode + encode in hardware via VA-API. Measured on this machine: **177 fps (7.4x realtime)** for a 1080p H.264 transcode, versus 62 fps (2.6x) on the CPU. HEVC/H.265, VP9 and AV1 have no hardware path and fall back to the CPU, which struggles above 1080p. HDR tone-mapping is not possible. Setup steps in [Step 4.7](docs/04-deploy-the-stack.md#step-47--enable-hardware-transcoding-va-api).
- **16 GB RAM is the ceiling.** With everything idle it sits around 2 GB used — plenty of headroom for normal use.
- **HTTPS on `*.yourdomain.internal` is not possible** — `.internal` is a reserved private TLD, so no public CA can issue a certificate for it. Either stay on plain HTTP inside the LAN, or move your internal hostnames onto a subdomain of a domain you actually own (`jellyfin.home.example.com`) and let NPM issue certs through the Cloudflare **DNS-01** challenge. DNS-01 validates over DNS records instead of an HTTP request, so it works for names that only resolve on your LAN, with nothing exposed to the internet.
- **Some proxy behaviour is not in the NPM UI** — see [`npm-custom/`](npm-custom/). Files under `npm/data/nginx/custom/` are included by every proxy host and shown nowhere.
- **Runtime data is excluded** from this repo via `.gitignore`. Each service writes its own data locally on your machine (photos in Nextcloud, media library in Jellyfin, etc.). Only the recipe files are tracked here.

---

## Setup guide

One file per phase in [`docs/`](docs/README.md):

0. [Check the drive first](docs/00-ssd.md) — optional: swap the stock 5400 rpm HDD for an SSD, before installing anything
1. [Install Ubuntu Server](docs/01-install-ubuntu.md) on the Mac Mini
2. [Set up SSH access](docs/02-ssh.md)
3. [Install Docker](docs/03-docker.md)
4. [Deploy the stack](docs/04-deploy-the-stack.md): first-run wizards for each service, Pi-hole as the network's DNS, VA-API hardware transcoding for Jellyfin
5. [Netbird](docs/05-netbird.md) for remote access
6. [Push notifications](docs/06-push-notifications.md) on import via ntfy (Radarr/Sonarr/Seerr), and Uptime Kuma alerts
7. [Route qBittorrent through a VPN](docs/07-qbittorrent-vpn.md) with a real kill switch
8. [Prefer H.264](docs/08-prefer-h264.md) over HEVC/AV1 in Sonarr and Radarr, so the server stops transcoding what it cannot hardware-decode
9. [Torrent guard](docs/09-torrent-guard.md) against executables wearing a release name, and demote the indexer that served one
10. [Public links through a relay VPS](docs/10-public-relay.md) — optional: `https://` for family and friends, with no VPN app for them and one encrypted flow for your ISP to see. Netbird keeps working alongside it
11. [Encrypt Pi-hole's upstream DNS](docs/11-encrypted-dns.md), so the ISP cannot read the household's lookups
12. [Per-user content filters](docs/12-content-filters.md) — optional: in Seerr and Jellyfin, on stock Seerr that updates itself
13. [Offsite backups](docs/13-backups.md) to Backblaze B2 — encrypted before they leave the house, sent through the VPN, alerting when a backup *stops* happening

Reference: [storage](docs/storage.md), [release rules](docs/release-rules.md), [subtitles](docs/subtitles.md), [getting help](docs/getting-help.md). Ideas for later: [TODO.md](TODO.md).

---

## License

Personal project. Use it, fork it, learn from it. No warranty.
